import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  AIToolCall,
  AgentDefinitionInput,
  AgentDefinition,
  AgentConfig,
  AgentPermissionSettings,
  CollaborationWorkflowInput,
  CollaborationWorkflowGraph,
  CollaborationRequest,
  CollaborationResponse,
  CollaborationRole,
  CollaborationRoleOutput,
  CollaborationRoleSpec,
  MemoryRecord,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderId,
  ProviderRerankRequest,
  ProviderRerankResponse,
  ProviderRuntimeStatus,
  ProviderUsageOutcome,
  TaskState,
  WorkflowRunState,
} from '@ide/protocol';
import {
  AI_PATCH_TOOL_INSTRUCTIONS,
  AI_PATCH_TOOL_NAME,
  AI_PATCH_TOOL_SPEC,
} from '@ide/protocol';

import { CompactionService, ContextBuilderService, RoleOrchestrationService, AgentLoader } from '@ide/ai-core';

import { AIRouterEngine } from './router/ai-router';
import { createStableCacheKey } from './cache-key';
import { CacheOrchestrator } from './cache-orchestrator';
import { ResponseValidator } from './safety/response-validator';
import { UsageLog } from './telemetry/usage-log';
import { TraceService } from './telemetry/trace-service';
import { InMemorySessionStore } from './memory/session-store';
import { WorkspaceContextService } from './memory/workspace-context';
import type { ObsidianMemoryStats } from './memory/workspace-context';
import type { PatchService } from './patches';
import type { LocalFirstSettingsService } from './settings';
import { PermissionService } from './permissions';
import { DefaultPluginHookRegistry } from './plugin-hooks';
import { WorkflowStore } from './workflows';
import { WorkflowEngine } from './workflow/workflow-engine';

export class AIController {
  private readonly permissionService: PermissionService;
  private readonly compactionService: CompactionService;
  private readonly pluginRegistry: DefaultPluginHookRegistry;
  private readonly cacheOrchestrator = new CacheOrchestrator();
  private readonly agentLoader: AgentLoader;
  private readonly workflowStore: WorkflowStore;
  private readonly workflowEngine: WorkflowEngine;
  private readonly traceService: TraceService;
  private activeAgentId = 'build';

  constructor(
    private readonly router: AIRouterEngine,
    private readonly contextBuilder: ContextBuilderService = new ContextBuilderService(),
    private readonly sessionStore: InMemorySessionStore = new InMemorySessionStore(),
    private readonly workspace: WorkspaceContextService = new WorkspaceContextService(),
    private readonly validator: ResponseValidator = new ResponseValidator(),
    private readonly patchService?: PatchService,
    private readonly roleOrchestrator: RoleOrchestrationService = new RoleOrchestrationService(),
    private readonly settingsService?: LocalFirstSettingsService,
  ) {
    this.agentLoader = new AgentLoader({ workspaceRoot: '' });
    this.workflowStore = new WorkflowStore({ workspaceRoot: '' });
    this.workflowEngine = new WorkflowEngine();
    this.traceService = new TraceService();
    const permissions = this.settingsService?.getEffectiveSettings().policy?.permissions;
    this.permissionService = new PermissionService(permissions);
    this.compactionService = new CompactionService();
    this.pluginRegistry = new DefaultPluginHookRegistry();
  }

  /**
   * Register a plugin hook (OpenCode-style)
   */
  registerPluginHook(hook: import('@ide/protocol').GatewayPluginHook): void {
    this.pluginRegistry.register(hook);
  }

  /**
   * Check permission for a tool
   */
  checkPermission(tool: keyof AgentPermissionSettings, args?: string): { allowed: boolean; requiresAsk: boolean; denied: boolean } {
    if (args && (tool === 'bash' || tool === 'task' || tool === 'externalDirectory')) {
      return this.permissionService.checkToolWithArgs(tool, args);
    }
    return this.permissionService.checkTool(tool);
  }

  /**
   * Update compaction settings at runtime
   */
  updateCompactionOptions(options: import('@ide/ai-core').CompactionOptions): void {
    this.compactionService.updateOptions(options);
  }

  async handleGenerate(request: AIRequest): Promise<AIResponse> {
    const enrichedRequest = this.applyLocalPolicy(
      this.withPatchTooling(await this.enrichWithWorkspace(request)),
    );
    await this.ensureLocalOnlyRuntimeReady(enrichedRequest);

    const taskState = await this.sessionStore.ensureTaskState(
      enrichedRequest.context.sessionId,
      enrichedRequest.prompt,
    );

    const packet = await this.getOrBuildContextPacket(enrichedRequest, taskState);
    const augmentedPrompt = this.contextBuilder.buildPromptWithContext(
      enrichedRequest.prompt,
      packet,
      this.getAgentInstructions(),
    );

    const augmentedRequest: AIRequest = {
      ...enrichedRequest,
      prompt: augmentedPrompt,
      context: {
        ...enrichedRequest.context,
        metadata: {
          ...request.context.metadata,
          sessionGoal: taskState.goal,
          decisions: taskState.decisions,
          handoffSummary: taskState.lastHandoffSummary,
        },
      },
    };

    // Apply plugin hooks (OpenCode-style) before routing
    const hookedRequest = await this.pluginRegistry.beforeRequest(augmentedRequest);

    // Optional: trigger context compaction if task state is too large
    const compactedState = this.compactionService.compactTaskState(taskState);
    if (compactedState.summary) {
      await this.sessionStore.updateHandoffSummary(
        request.context.sessionId,
        compactedState.summary,
      );
      this.cacheOrchestrator.invalidate({
        type: 'session.memory.changed',
        namespace: 'context-packet',
        scope: 'session',
        scopeId: request.context.sessionId,
      });
    }

    const decision = await this.router.route(hookedRequest);
    const response = await this.router.execute(hookedRequest, decision);
    await this.validator.validateResponse(response);
    const responseWithPatches = await this.recordPatchToolCallsFromResponse(response, hookedRequest);

    // Apply plugin hooks after response
    const hookedResponse = await this.pluginRegistry.afterResponse(responseWithPatches);

    const usage: ProviderUsageOutcome = {
      requestId: request.id,
      providerId: responseWithPatches.providerId,
      modelId: responseWithPatches.modelId,
      success: true,
      latencyMs: responseWithPatches.usage?.latencyMs,
      inputTokens: responseWithPatches.usage?.inputTokens,
      outputTokens: responseWithPatches.usage?.outputTokens,
      estimatedCostUsd: responseWithPatches.usage?.estimatedCostUsd,
      chosenAs: 'primary',
      timestamp: new Date().toISOString(),
    };
    await this.sessionStore.recordProviderUsage(request.context.sessionId, usage);

    const outcome = this.contextBuilder.extractOutcome(responseWithPatches, request);
    const updatedHandoffSummary = this.contextBuilder.buildHandoffSummary(taskState);
    await this.sessionStore.updateHandoffSummary(
      request.context.sessionId,
      updatedHandoffSummary,
    );
    this.cacheOrchestrator.invalidate({
      type: 'session.memory.changed',
      namespace: 'context-packet',
      scope: 'session',
      scopeId: request.context.sessionId,
    });

    return {
      ...hookedResponse,
      metadata: {
        ...hookedResponse.metadata,
        sessionId: request.context.sessionId,
        taskGoal: taskState.goal,
        handoffSummary: taskState.lastHandoffSummary,
        outcome,
      },
    };
  }

  async handleStream(request: AIRequest, options: { signal?: AbortSignal } = {}): Promise<AsyncIterable<AIStreamEvent>> {
    const policyRequest = this.applyLocalPolicy(
      this.withPatchTooling(await this.enrichWithWorkspace(request)),
    );
    await this.ensureLocalOnlyRuntimeReady(policyRequest);
    const taskState = await this.sessionStore.ensureTaskState(
      policyRequest.context.sessionId,
      policyRequest.prompt,
    );

    const packet = await this.getOrBuildContextPacket(policyRequest, taskState);
    const augmentedPrompt = this.contextBuilder.buildPromptWithContext(
      policyRequest.prompt,
      packet,
      this.getAgentInstructions(),
    );

    const augmentedRequest: AIRequest = { ...policyRequest, prompt: augmentedPrompt };

    // Apply plugin hooks (OpenCode-style) before routing
    const hookedRequest = await this.pluginRegistry.beforeRequest(augmentedRequest);

    const decision = await this.router.route(hookedRequest);
    const adapter = this.router.getAdapter(decision.chosen.providerId);

    // Production trace: log the prompt step
    this.traceService.logPrompt(request.context.sessionId, this.activeAgentId, {
      promptLength: hookedRequest.prompt.length,
      modelId: decision.chosen.modelId,
      providerId: decision.chosen.providerId as string,
      temperature: hookedRequest.temperature,
      maxTokens: hookedRequest.maxTokens,
    });

    if (!adapter) {
      throw new Error(`No adapter for provider ${decision.chosen.providerId}`);
    }

    const usage: ProviderUsageOutcome = {
      requestId: policyRequest.id,
      providerId: decision.chosen.providerId,
      modelId: decision.chosen.modelId,
      success: true,
      chosenAs: 'primary',
      timestamp: new Date().toISOString(),
    };
    await this.sessionStore.recordProviderUsage(policyRequest.context.sessionId, usage);

    const startTime = Date.now();
    const stream = this.recordPatchToolCalls(await adapter.streamText({
      requestId: hookedRequest.id,
      modelId: decision.chosen.modelId,
      prompt: hookedRequest.prompt,
      context: hookedRequest.context,
      maxTokens: hookedRequest.maxTokens,
      temperature: hookedRequest.temperature,
      tools: hookedRequest.tools,
      stream: true,
      signal: options.signal,
    }), hookedRequest);

    return this.traceStream(stream, request.context.sessionId, {
      providerId: decision.chosen.providerId as string,
      modelId: decision.chosen.modelId,
      startTime,
    });
  }

  async handleCollaborate(request: CollaborationRequest): Promise<CollaborationResponse> {
    if (!request.id?.trim()) {
      throw new Error('Collaboration request id is required');
    }
    if (!request.goal?.trim()) {
      throw new Error('Collaboration goal is required');
    }

    const createdAt = new Date().toISOString();
    const seedRequest: AIRequest = {
      id: request.id,
      kind: request.kind ?? 'refactor',
      prompt: request.goal,
      context: request.context,
      strategy: request.strategy,
      temperature: request.temperature,
    };
    const enrichedRequest = this.applyLocalPolicy(await this.enrichWithWorkspace(seedRequest));
    await this.ensureLocalOnlyRuntimeReady(enrichedRequest);
    let collaboration: CollaborationRequest = {
      ...request,
      kind: seedRequest.kind,
      context: enrichedRequest.context,
    };
    const selectedWorkflow = request.workflowId ? this.workflowStore.get(request.workflowId) : null;
    if (selectedWorkflow) {
      collaboration = {
        ...collaboration,
        team: selectedWorkflow.team ?? collaboration.team,
        roles: selectedWorkflow.roles,
        maxTokensPerRole: collaboration.maxTokensPerRole ?? selectedWorkflow.maxTokensPerRole,
        temperature: collaboration.temperature ?? selectedWorkflow.temperature,
        metadata: {
          ...collaboration.metadata,
          workflowId: selectedWorkflow.id,
          workflowName: selectedWorkflow.name,
          workflowGraph: selectedWorkflow.graph,
        },
      };
    }

    const taskState = await this.sessionStore.ensureTaskState(
      collaboration.context.sessionId,
      collaboration.goal,
    );
    const packet = await this.getOrBuildContextPacket(enrichedRequest, taskState);
    const teamResolution = this.roleOrchestrator.resolveTeam(collaboration);
    const rolePlan = this.withWorkflowGraphNodes(
      this.withSpecialistAgents(
        this.roleOrchestrator.buildRolePlan(collaboration),
        collaboration,
      ),
      selectedWorkflow?.graph,
    );
    const executionWaves = selectedWorkflow?.graph
      ? this.buildGraphExecutionWaves(rolePlan, selectedWorkflow.graph)
      : this.roleOrchestrator.buildExecutionWaves(rolePlan);
    this.traceService.logWorkflow(collaboration.context.sessionId, 'manager', {
      event: 'team_resolved',
      teamId: teamResolution.teamId,
      reason: teamResolution.reason,
      autoSelected: teamResolution.autoSelected,
      workflowId: selectedWorkflow?.id,
      workflowName: selectedWorkflow?.name,
      workflowGraphNodeCount: selectedWorkflow?.graph?.nodes.length,
      workflowGraphEdgeCount: selectedWorkflow?.graph?.edges.length,
      roles: teamResolution.roles,
      specialistAgents: rolePlan.map((role) => ({
        role: role.role,
        agentId: role.specialistAgentId,
        agentName: role.specialistAgentName,
        nodeId: role.workflowNodeId,
        nodeLabel: role.workflowNodeLabel,
      })),
      waves: executionWaves.map((wave) => wave.map((role) => role.role)),
      graphNodeWaves: executionWaves.map((wave) => wave.map((role) => role.workflowNodeId ?? role.role)),
    });

    // ─── Engine-based execution for graphs with advanced nodes ───
    const hasAdvancedNodes = selectedWorkflow?.graph?.nodes.some(
      (node) => node.type === 'approval' || node.type === 'condition' || node.type === 'retry',
    );

    if (hasAdvancedNodes && selectedWorkflow?.graph) {
      const executeNode = this.createNodeExecutor(collaboration, packet);
      const runId = `run-${collaboration.id}-${Date.now()}`;
      const runState = await this.workflowEngine.executeWorkflow({
        runId,
        workflowId: selectedWorkflow.id,
        collaborationId: collaboration.id,
        graph: selectedWorkflow.graph,
        rolePlan,
        packet,
        executeNode,
      });

      const outputs = runState.outputs;
      const finalOutput = findLastRoleOutput(outputs, 'synthesizer') ?? outputs[outputs.length - 1];

      if (runState.status === 'paused_approval') {
        // Return partial result with run state for UI polling
        return {
          id: collaboration.id,
          requestId: request.id,
          sessionId: collaboration.context.sessionId,
          goal: collaboration.goal,
          rolePlan,
          outputs,
          finalOutput: finalOutput ?? {
            id: `${collaboration.id}:paused`,
            role: 'synthesizer',
            kind: 'synthesis',
            status: 'skipped',
            summary: `Workflow paused at approval node: ${runState.pausedAtNodeId}`,
            content: 'Waiting for human approval before continuing.',
            artifacts: [],
            startedAt: createdAt,
            completedAt: new Date().toISOString(),
            inputRoleIds: [],
          },
          warnings: [`Workflow paused at approval node: ${runState.pausedAtNodeId}`],
          createdAt,
          completedAt: new Date().toISOString(),
          runState,
          metadata: {
            workflowId: selectedWorkflow.id,
            workflowName: selectedWorkflow.name,
            runId: runState.runId,
            runStatus: runState.status,
            pausedAtNodeId: runState.pausedAtNodeId,
          },
        };
      }

      if (!finalOutput) {
        throw new Error('Collaboration produced no role outputs');
      }

      const handoff = this.buildCollaborationHandoff(collaboration, outputs);
      await this.sessionStore.updateHandoffSummary(collaboration.context.sessionId, handoff);
      const obsidianMemoryPath = await this.recordCollaborationObsidianMemory(collaboration, outputs, finalOutput);

      return {
        id: collaboration.id,
        requestId: request.id,
        sessionId: collaboration.context.sessionId,
        goal: collaboration.goal,
        rolePlan,
        outputs,
        finalOutput,
        createdAt,
        completedAt: new Date().toISOString(),
        runState,
        metadata: {
          rolesCompleted: outputs.filter((o) => o.status === 'completed').length,
          rolesFailed: outputs.filter((o) => o.status === 'failed').length,
          teamId: teamResolution.teamId,
          teamReason: teamResolution.reason,
          workflowId: selectedWorkflow.id,
          workflowName: selectedWorkflow.name,
          runId: runState.runId,
          runStatus: runState.status,
          obsidianMemoryPath,
        },
      };
    }

    // ─── Legacy wave-based execution (simple graphs) ───
    const outputs: CollaborationRoleOutput[] = [];
    const warnings: string[] = [];

    for (const [waveIndex, wave] of executionWaves.entries()) {
      const previousOutputs = [...outputs];
      this.traceService.logWorkflow(collaboration.context.sessionId, 'manager', {
        event: 'wave_started',
        waveIndex: waveIndex + 1,
        roles: wave.map((role) => role.role),
        graphNodes: wave.map((role) => role.workflowNodeId ?? role.role),
      });
      const waveOutputs = await Promise.all(wave.map(async (roleSpec) => {
        const startedAt = new Date().toISOString();
        const baseRoleRequest = this.roleOrchestrator.buildRoleRequest({
          collaboration,
          roleSpec,
          packet,
          previousOutputs,
        });
        const roleRequest = this.withSpecialistAgentInstructions(baseRoleRequest, roleSpec);
        const traceAgentId = roleSpec.specialistAgentId ?? roleSpec.role;

        try {
          const decision = await this.router.route(roleRequest);
          const startedMs = Date.now();
          this.traceService.logPrompt(collaboration.context.sessionId, traceAgentId, {
            role: roleSpec.role,
            workflowNodeId: roleSpec.workflowNodeId,
            workflowNodeLabel: roleSpec.workflowNodeLabel,
            specialistAgentName: roleSpec.specialistAgentName,
            promptLength: roleRequest.prompt.length,
            modelId: decision.chosen.modelId,
            providerId: decision.chosen.providerId as string,
            temperature: roleRequest.temperature,
            maxTokens: roleRequest.maxTokens,
          });

          const response = await this.router.execute(roleRequest, decision);
          await this.validator.validateResponse(response);

          const output = this.roleOrchestrator.buildRoleOutput({
            collaborationId: collaboration.id,
            roleSpec,
            response,
            startedAt,
            previousOutputs,
          });

          this.traceService.logResponse(collaboration.context.sessionId, traceAgentId, {
            role: roleSpec.role,
            workflowNodeId: roleSpec.workflowNodeId,
            workflowNodeLabel: roleSpec.workflowNodeLabel,
            specialistAgentName: roleSpec.specialistAgentName,
            responseLength: response.text?.length ?? 0,
            tokensUsed: response.usage?.totalTokens,
            finishReason: 'complete',
            durationMs: Date.now() - startedMs,
          });

          const usage: ProviderUsageOutcome = {
            requestId: roleRequest.id,
            providerId: response.providerId,
            modelId: response.modelId,
            success: true,
            latencyMs: response.usage?.latencyMs,
            inputTokens: response.usage?.inputTokens,
            outputTokens: response.usage?.outputTokens,
            estimatedCostUsd: response.usage?.estimatedCostUsd,
            chosenAs: response.metadata?.fallbackFrom ? 'fallback' : 'primary',
            role: roleSpec.role,
            taskKind: roleRequest.kind,
            collaborationId: collaboration.id,
            timestamp: output.completedAt,
          };
          await this.sessionStore.recordProviderUsage(collaboration.context.sessionId, usage);
          await this.recordRoleMemory(collaboration, output);
          return output;
        } catch (err) {
          const output = this.roleOrchestrator.buildFailureOutput({
            collaborationId: collaboration.id,
            roleSpec,
            error: err,
            startedAt,
            previousOutputs,
          });
          this.traceService.logError(collaboration.context.sessionId, traceAgentId, {
            role: roleSpec.role,
            workflowNodeId: roleSpec.workflowNodeId,
            workflowNodeLabel: roleSpec.workflowNodeLabel,
            specialistAgentName: roleSpec.specialistAgentName,
            message: output.summary,
            retryable: false,
          });
          warnings.push(`${roleSpec.role} failed: ${output.summary}`);
          await this.recordRoleMemory(collaboration, output);
          return output;
        }
      }));

      outputs.push(...waveOutputs);
      this.traceService.logWorkflow(collaboration.context.sessionId, 'manager', {
        event: 'wave_completed',
        waveIndex: waveIndex + 1,
        outputs: waveOutputs.map((output) => ({
          role: output.role,
          workflowNodeId: output.workflowNodeId,
          status: output.status,
          summary: output.summary,
        })),
      });
    }

    const finalOutput = findLastRoleOutput(outputs, 'synthesizer') ?? outputs[outputs.length - 1];
    if (!finalOutput) {
      throw new Error('Collaboration produced no role outputs');
    }

    const handoff = this.buildCollaborationHandoff(collaboration, outputs);
    this.traceService.logHandoff(collaboration.context.sessionId, 'manager', {
      event: 'collaboration_handoff',
      collaborationId: collaboration.id,
      outputCount: outputs.length,
      finalRole: finalOutput.role,
      finalSummary: finalOutput.summary,
    });
    await this.sessionStore.updateHandoffSummary(
      collaboration.context.sessionId,
      handoff,
    );
    const obsidianMemoryPath = await this.recordCollaborationObsidianMemory(collaboration, outputs, finalOutput);
    this.cacheOrchestrator.invalidate({
      type: 'session.memory.changed',
      namespace: 'context-packet',
      scope: 'session',
      scopeId: collaboration.context.sessionId,
    });

    return {
      id: collaboration.id,
      requestId: request.id,
      sessionId: collaboration.context.sessionId,
      goal: collaboration.goal,
      rolePlan,
      outputs,
      finalOutput,
      warnings: warnings.length ? warnings : undefined,
      createdAt,
      completedAt: new Date().toISOString(),
      metadata: {
        rolesCompleted: outputs.filter((output) => output.status === 'completed').length,
        rolesFailed: outputs.filter((output) => output.status === 'failed').length,
        teamId: teamResolution.teamId,
        teamReason: teamResolution.reason,
        autoSelectedTeam: teamResolution.autoSelected,
        resolvedRoles: teamResolution.roles,
        specialistAgents: rolePlan.map((role) => ({
          role: role.role,
          agentId: role.specialistAgentId,
          agentName: role.specialistAgentName,
          nodeId: role.workflowNodeId,
          nodeLabel: role.workflowNodeLabel,
        })),
        workflowId: selectedWorkflow?.id,
        workflowName: selectedWorkflow?.name,
        workflowGraph: selectedWorkflow?.graph,
        executionWaves: executionWaves.map((wave) => wave.map((role) => role.role)),
        graphNodeWaves: executionWaves.map((wave) => wave.map((role) => role.workflowNodeId ?? role.role)),
        obsidianMemoryPath,
      },
    };
  }

  async handleEmbed(_request: ProviderEmbedRequest): Promise<ProviderEmbedResponse> {
    return {
      providerId: 'custom',
      modelId: 'embedding-placeholder',
      embeddings: [],
    };
  }

  async handleRerank(_request: ProviderRerankRequest): Promise<ProviderRerankResponse> {
    return {
      providerId: 'custom',
      modelId: 'rerank-placeholder',
      rankedCandidates: [],
    };
  }

  getUsageLog(): UsageLog {
    return this.router.getUsageLog();
  }

  getAdapter(providerId: ProviderId) {
    return this.router.getAdapter(providerId);
  }

  getProviderStatuses(): Promise<ProviderRuntimeStatus[]> {
    return this.router.getProviderStatuses();
  }

  testProviderConnection(providerId: ProviderId): Promise<ProviderRuntimeStatus | null> {
    return this.router.testProviderConnection(providerId);
  }

  hasReachableLocalModel(allowedProviderIds?: ProviderId[]): Promise<boolean> {
    return this.router.hasReachableLocalModel(allowedProviderIds);
  }

  getSessionState(sessionId: string): Promise<TaskState | null> {
    return this.sessionStore.getTaskState(sessionId);
  }

  listSessions(): Promise<string[]> {
    return this.sessionStore.listSessions();
  }

  async addDecision(sessionId: string, decision: string): Promise<void> {
    await this.sessionStore.addDecision(sessionId, decision);
    this.cacheOrchestrator.invalidate({
      type: 'session.memory.changed',
      namespace: 'context-packet',
      scope: 'session',
      scopeId: sessionId,
    });
  }

  async addConstraint(sessionId: string, constraint: string): Promise<void> {
    await this.sessionStore.addConstraint(sessionId, constraint);
    this.cacheOrchestrator.invalidate({
      type: 'session.memory.changed',
      namespace: 'context-packet',
      scope: 'session',
      scopeId: sessionId,
    });
  }

  async setWorkspaceRoot(rootDir: string): Promise<void> {
    await this.workspace.setWorkspaceRoot(rootDir);
    this.agentLoader.setWorkspaceRoot(rootDir);
    this.workflowStore.setWorkspaceRoot(rootDir);
    this.agentLoader.ensureBootstrapInstructions();
    this.cacheOrchestrator.invalidate({ type: 'workspace.root.changed', namespace: 'context-packet', scope: 'workspace' });
  }

  getWorkspaceRoot(): string | null {
    return this.workspace.getWorkspaceRoot();
  }

  setActiveAgent(agentId: string): void {
    this.activeAgentId = agentId;
  }

  getActiveAgentId(): string {
    return this.activeAgentId;
  }

  listAgents() {
    return this.agentLoader.listAgents();
  }

  getAgent(agentId: string) {
    return this.agentLoader.getAgent(agentId);
  }

  saveAgent(input: AgentDefinitionInput) {
    return this.agentLoader.saveAgent(input);
  }

  listWorkflows() {
    return this.workflowStore.list();
  }

  saveWorkflow(input: CollaborationWorkflowInput) {
    return this.workflowStore.save(input);
  }

  deleteWorkflow(workflowId: string): void {
    this.workflowStore.delete(workflowId);
  }

  getWorkflowVersions(workflowId: string) {
    return this.workflowStore.getVersions(workflowId);
  }

  rollbackWorkflow(workflowId: string, version: number) {
    return this.workflowStore.rollback(workflowId, version);
  }

  listWorkflowRuns(workflowId?: string): WorkflowRunState[] {
    return this.workflowEngine.listRuns(workflowId);
  }

  getWorkflowRun(runId: string): WorkflowRunState | undefined {
    return this.workflowEngine.getRun(runId);
  }

  cancelWorkflowRun(runId: string): WorkflowRunState {
    return this.workflowEngine.cancelRun(runId);
  }

  /** Expose engine event subscription for SSE streaming */
  onWorkflowEvent(listener: (event: import('@ide/protocol').WorkflowRunEvent) => void): () => void {
    return this.workflowEngine.onEvent(listener);
  }

  async approveWorkflowRun(runId: string, nodeId?: string, reason?: string): Promise<WorkflowRunState> {
    const run = this.workflowEngine.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (!run.pausedAtNodeId) throw new Error(`Run ${runId} is not paused`);

    const workflow = this.workflowStore.get(run.workflowId);
    if (!workflow?.graph) throw new Error(`Workflow ${run.workflowId} has no graph`);

    const stubContext = { sessionId: '', workspaceId: '', metadata: {} };
    const rolePlan = this.withWorkflowGraphNodes(
      this.withSpecialistAgents(
        this.roleOrchestrator.buildRolePlan({
          id: run.collaborationId, goal: '', context: stubContext,
        }),
        { id: run.collaborationId, goal: '', context: stubContext } as CollaborationRequest,
      ),
      workflow.graph,
    );

    const taskState = await this.sessionStore.ensureTaskState('', '');
    const stubRequest: AIRequest = {
      id: run.collaborationId,
      kind: 'edit',
      prompt: '',
      context: stubContext,
    };
    const packet = await this.getOrBuildContextPacket(stubRequest, taskState);

    const executeNode = this.createNodeExecutor(
      { id: run.collaborationId, goal: '', context: stubContext } as CollaborationRequest,
      packet,
    );

    return this.workflowEngine.resumeRun(
      runId,
      {
        runId,
        nodeId: nodeId ?? run.pausedAtNodeId,
        decision: 'approve',
        reason,
        decidedAt: new Date().toISOString(),
      },
      workflow.graph,
      rolePlan,
      packet,
      executeNode,
    );
  }

  async rejectWorkflowRun(runId: string, nodeId?: string, reason?: string): Promise<WorkflowRunState> {
    const run = this.workflowEngine.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (!run.pausedAtNodeId) throw new Error(`Run ${runId} is not paused`);

    const workflow = this.workflowStore.get(run.workflowId);
    if (!workflow?.graph) throw new Error(`Workflow ${run.workflowId} has no graph`);

    return this.workflowEngine.resumeRun(
      runId,
      {
        runId,
        nodeId: nodeId ?? run.pausedAtNodeId,
        decision: 'reject',
        reason,
        decidedAt: new Date().toISOString(),
      },
      workflow.graph,
      [],
      {} as any,
      async () => { throw new Error('rejected'); },
    );
  }
  private createNodeExecutor(
    collaboration: CollaborationRequest,
    packet: import('@ide/protocol').ContextPacket,
  ): import('./workflow/workflow-engine').WorkflowEngineExecuteNodeFn {
    return async (_nodeId, roleSpec, previousOutputs) => {
      const startedAt = new Date().toISOString();
      const baseRoleRequest = this.roleOrchestrator.buildRoleRequest({
        collaboration,
        roleSpec,
        packet,
        previousOutputs,
      });
      const roleRequest = this.withSpecialistAgentInstructions(baseRoleRequest, roleSpec);

      try {
        const decision = await this.router.route(roleRequest);
        const response = await this.router.execute(roleRequest, decision);
        await this.validator.validateResponse(response);

        const output = this.roleOrchestrator.buildRoleOutput({
          collaborationId: collaboration.id,
          roleSpec,
          response,
          startedAt,
          previousOutputs,
        });

        const usage: ProviderUsageOutcome = {
          requestId: roleRequest.id,
          providerId: response.providerId,
          modelId: response.modelId,
          success: true,
          latencyMs: response.usage?.latencyMs,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          estimatedCostUsd: response.usage?.estimatedCostUsd,
          chosenAs: response.metadata?.fallbackFrom ? 'fallback' : 'primary',
          role: roleSpec.role,
          taskKind: roleRequest.kind,
          collaborationId: collaboration.id,
          timestamp: output.completedAt,
        };
        await this.sessionStore.recordProviderUsage(collaboration.context.sessionId, usage);
        await this.recordRoleMemory(collaboration, output);
        return output;
      } catch (err) {
        const output = this.roleOrchestrator.buildFailureOutput({
          collaborationId: collaboration.id,
          roleSpec,
          error: err,
          startedAt,
          previousOutputs,
        });
        await this.recordRoleMemory(collaboration, output);
        return output;
      }
    };
  }

  private withWorkflowGraphNodes(
    rolePlan: CollaborationRoleSpec[],
    graph: CollaborationWorkflowGraph | undefined,
  ): CollaborationRoleSpec[] {
    if (!graph?.nodes.length) {
      return rolePlan;
    }

    const roleNodes = graph.nodes.filter((node) => node.role);
    return rolePlan.map((roleSpec) => {
      const node = roleNodes.find((candidate) => candidate.role === roleSpec.role);
      if (!node) {
        return roleSpec;
      }

      return {
        ...roleSpec,
        workflowNodeId: node.id,
        workflowNodeLabel: node.label,
        specialistAgentId: node.agentId ?? roleSpec.specialistAgentId,
        specialistAgentName: node.agentId
          ? this.agentLoader.getAgent(node.agentId)?.name ?? roleSpec.specialistAgentName
          : roleSpec.specialistAgentName,
      };
    });
  }

  private buildGraphExecutionWaves(
    rolePlan: CollaborationRoleSpec[],
    graph: CollaborationWorkflowGraph,
  ): CollaborationRoleSpec[][] {
    const byNodeId = new Map(
      rolePlan
        .filter((role) => role.workflowNodeId)
        .map((role) => [role.workflowNodeId as string, role]),
    );
    if (!byNodeId.size) {
      return this.roleOrchestrator.buildExecutionWaves(rolePlan);
    }

    const pending = new Set([...byNodeId.keys()]);
    const completed = new Set<string>();
    const waves: CollaborationRoleSpec[][] = [];

    while (pending.size > 0) {
      const runnable = [...pending].filter((nodeId) => {
        const dependencies = graph.edges
          .filter((edge) => edge.target === nodeId && byNodeId.has(edge.source))
          .map((edge) => edge.source);
        return dependencies.every((dependency) => completed.has(dependency));
      });

      if (!runnable.length) {
        waves.push([...pending].map((nodeId) => byNodeId.get(nodeId)).filter(isRoleSpec));
        break;
      }

      waves.push(runnable.map((nodeId) => byNodeId.get(nodeId)).filter(isRoleSpec));
      for (const nodeId of runnable) {
        pending.delete(nodeId);
        completed.add(nodeId);
      }
    }

    const plannedRoles = new Set(waves.flat().map((role) => role.role));
    const unplanned = rolePlan.filter((role) => !plannedRoles.has(role.role));
    if (unplanned.length) {
      waves.push(unplanned);
    }

    return waves;
  }

  private withSpecialistAgents(
    rolePlan: CollaborationRoleSpec[],
    collaboration: CollaborationRequest,
  ): CollaborationRoleSpec[] {
    return rolePlan.map((roleSpec) => {
      const specialist = this.resolveSpecialistAgent(roleSpec.role, collaboration);
      if (!specialist) {
        return roleSpec;
      }

      return {
        ...roleSpec,
        specialistAgentId: specialist.id,
        specialistAgentName: specialist.name,
      };
    });
  }

  private withSpecialistAgentInstructions(request: AIRequest, roleSpec: CollaborationRoleSpec): AIRequest {
    if (!roleSpec.specialistAgentId) {
      return request;
    }

    const specialist = this.agentLoader.getAgent(roleSpec.specialistAgentId);
    if (!specialist) {
      return request;
    }

    const specialistPrompt = this.agentLoader.getAgentPrompt(specialist);
    return {
      ...request,
      prompt: [
        `<specialist-agent id="${specialist.id}" name="${specialist.name}">`,
        specialistPrompt,
        '</specialist-agent>',
        '',
        request.prompt,
      ].join('\n'),
      context: {
        ...request.context,
        metadata: {
          ...request.context.metadata,
          specialistAgentId: specialist.id,
          specialistAgentName: specialist.name,
          specialistAgentMode: specialist.mode,
          specialistAgentPermissions: specialist.permissions,
        },
      },
      temperature: specialist.temperature ?? request.temperature,
    };
  }

  private resolveSpecialistAgent(role: CollaborationRole, collaboration: CollaborationRequest): AgentDefinition | null {
    const goal = collaboration.goal.toLowerCase();
    const workflowName = String(collaboration.metadata?.workflowName ?? '').toLowerCase();
    const requestedWorkflow = String(collaboration.context.metadata?.requestedWorkflow ?? '').toLowerCase();
    const text = `${goal} ${workflowName} ${requestedWorkflow}`;
    const isResearch = hasAny(text, ['research', 'ค้น', 'summarize', 'สรุป', 'docs', 'document', 'source']);
    const isSecurity = hasAny(text, ['security', 'auth', 'permission', 'secret', 'audit', 'injection']);
    const isDatabase = hasAny(text, ['database', 'schema', 'migration', 'mysql', 'postgres', 'redis', 'vector', 'qdrant', 'pgvector']);
    const isBackend = hasAny(text, ['backend', 'api', 'fastify', 'server', 'auth', 'session', 'websocket', 'sse', 'queue']);
    const isFrontend = hasAny(text, ['frontend', 'ui', 'ux', 'react', 'next', 'vue', 'component', 'dashboard', 'page', 'web app']);
    const isDevOps = hasAny(text, ['docker', 'deploy', 'ci', 'cd', 'monitoring', 'production', 'scaling', 'env']);

    const preferredAgentId = (() => {
      if (role === 'planner') {
        if (isFrontend) return 'product-manager';
        if (isDevOps) return 'devops-engineer';
        return 'product-manager';
      }
      if (role === 'context_curator') {
        if (isResearch) return 'explore';
        return 'explore';
      }
      if (role === 'coder') {
        if (isDatabase) return 'database-engineer';
        if (isBackend) return 'backend-developer';
        if (isDevOps) return 'devops-engineer';
        if (isFrontend) return 'frontend-developer';
        return 'frontend-developer';
      }
      if (role === 'reviewer') {
        if (isSecurity) return 'security-engineer';
        return 'reviewer';
      }
      if (role === 'verifier') {
        if (isDevOps) return 'devops-engineer';
        return 'tester';
      }
      if (role === 'synthesizer') {
        return 'product-manager';
      }
      return undefined;
    })();

    return preferredAgentId ? this.agentLoader.getAgent(preferredAgentId) : null;
  }

  private getAgentInstructions(): { instructions?: string; agentPrompt?: string; workspaceRoot?: string; modelId?: string } {
    const agent = this.agentLoader.getAgent(this.activeAgentId) ?? this.agentLoader.getDefaultAgent();
    const workspaceRoot = this.getWorkspaceRoot();
    return {
      instructions: this.agentLoader.loadInstructions(this.activeAgentId) ?? undefined,
      agentPrompt: this.agentLoader.getAgentPrompt(agent),
      workspaceRoot: workspaceRoot ?? undefined,
      modelId: agent.id !== 'build' ? `${agent.name} (${agent.id} mode)` : undefined,
    };
  }

  getTraceService(): TraceService {
    return this.traceService;
  }

  async getWorkspaceSummary(): Promise<string> {
    return this.workspace.getRepoSummary();
  }

  async searchWorkspaceFiles(query: string): Promise<Array<{ path: string; content: string }>> {
    return this.workspace.searchFiles(query);
  }

  searchObsidianMemory(query: string) {
    return this.workspace.searchObsidianNotes(query, 12);
  }

  getObsidianMemoryStats(): ObsidianMemoryStats {
    return this.workspace.getObsidianStats();
  }

  async getWorkspaceFiles(): Promise<string[]> {
    return this.workspace.getFilePaths();
  }

  async readFileFromWorkspace(filePath: string): Promise<string> {
    return this.workspace.readFileContentStrict(filePath);
  }

  async saveFileToWorkspace(input: {
    filePath: string;
    content: string;
    expectedContent?: string;
  }): Promise<{ filePath: string; bytes: number; updatedAt: string }> {
    const result = await this.workspace.writeFileContent(input);
    this.cacheOrchestrator.invalidate({
      type: 'workspace.file.changed',
      namespace: 'context-packet',
      scope: 'workspace',
      scopeId: result.filePath,
    });
    return result;
  }

  isWorkspaceReady(): boolean {
    return this.workspace.isReady();
  }

  private withPatchTooling(request: AIRequest): AIRequest {
    if (!this.patchService || !shouldAttachPatchTool(request)) {
      return request;
    }

    const hasPatchTool = request.tools?.some((tool) => tool.name === AI_PATCH_TOOL_NAME) ?? false;
    const capabilities = new Set(request.preferredCapabilities ?? []);
    capabilities.add('codeEditing');
    capabilities.add('tools');

    return {
      ...request,
      prompt: request.prompt.includes(AI_PATCH_TOOL_NAME)
        ? request.prompt
        : `${request.prompt}\n\n${AI_PATCH_TOOL_INSTRUCTIONS}`,
      preferredCapabilities: [...capabilities],
      tools: hasPatchTool ? request.tools : [...(request.tools ?? []), AI_PATCH_TOOL_SPEC],
    };
  }

  private async *traceStream(
    stream: AsyncIterable<AIStreamEvent>,
    sessionId: string,
    meta: { providerId: string; modelId: string; startTime: number },
  ): AsyncIterable<AIStreamEvent> {
    let totalText = '';
    try {
      for await (const event of stream) {
        if (event.type === 'delta') totalText += event.text;
        if (event.type === 'tool_call') {
          this.traceService.logToolCall(sessionId, this.activeAgentId, {
            toolName: event.toolCall.name,
            arguments: event.toolCall.arguments,
          });
        }
        yield event;
      }
    } finally {
      this.traceService.logResponse(sessionId, this.activeAgentId, {
        responseLength: totalText.length,
        durationMs: Date.now() - meta.startTime,
        finishReason: 'complete',
      });
    }
  }

  private applyLocalPolicy(request: AIRequest): AIRequest {
    const effective = this.settingsService?.getEffectiveSettings(request.context.workspaceId);
    const effectivePolicy = effective?.policy;
    const isLocalOnly = effectivePolicy
      ? effectivePolicy.privacyMode === 'localOnly' || !effectivePolicy.allowCloudProviders
      : false;
    const allowedProviderIds = effective?.localProviderIds;
    const metadata = allowedProviderIds?.length
      ? {
          ...request.context.metadata,
          allowedProviderIds,
        }
      : request.context.metadata;

    if (!isLocalOnly) {
      return {
        ...request,
        strategy: request.strategy ?? effectivePolicy?.defaultStrategy,
        context: {
          ...request.context,
          metadata,
        },
      };
    }

    return {
      ...request,
      strategy: 'localOnly',
      preferredModelTier: 'local',
      context: {
        ...request.context,
        metadata: {
          ...metadata,
          privacyMode: 'localOnly',
          cloudProvidersAllowed: false,
        },
      },
    };
  }

  private async ensureLocalOnlyRuntimeReady(request: AIRequest): Promise<void> {
    if (request.strategy !== 'localOnly') {
      return;
    }

    const allowedProviderIds = providerIdsFromMetadata(request.context.metadata?.allowedProviderIds);
    if (!(await this.router.hasReachableLocalModel(allowedProviderIds))) {
      throw new Error('localOnly routing is enabled but no reachable local model is available');
    }
  }

  private async enrichWithWorkspace(request: AIRequest): Promise<AIRequest> {
    if (!this.workspace.isReady()) return request;

    const repoSummary = await this.workspace.getRepoSummary();

    let activeFileContent: string | undefined;
    if (request.context.activeFilePath) {
      activeFileContent = await this.workspace.readFileContent(request.context.activeFilePath);
    }

    const openFiles = request.context.openFiles ?? [];
    const filePaths = await this.workspace.getFilePaths();
    const obsidianKnowledgeContext = this.workspace.buildObsidianKnowledgeContext(request.prompt, 5);

    return {
      ...request,
      context: {
        ...request.context,
        repoSummary,
        ...(activeFileContent ? { selectedText: activeFileContent } : {}),
        openFiles: openFiles.length > 0 ? openFiles : filePaths.slice(0, 30),
        metadata: {
          ...request.context.metadata,
          ...(obsidianKnowledgeContext ? { obsidianKnowledgeContext } : {}),
        },
      },
    };
  }

  private async *recordPatchToolCalls(
    stream: AsyncIterable<AIStreamEvent>,
    request: AIRequest,
  ): AsyncIterable<AIStreamEvent> {
    for await (const event of stream) {
      if (event.type !== 'tool_call' || !this.patchService || event.toolCall.name !== AI_PATCH_TOOL_NAME) {
        yield event;
        continue;
      }

      try {
        const patch = await this.persistPatchToolCall(event.toolCall, request);

        yield {
          ...event,
          toolCall: {
            ...event.toolCall,
            arguments: {
              ...event.toolCall.arguments,
              patchId: patch.id,
            },
          },
        };
      } catch (err) {
        yield {
          type: 'warning',
          message: `Patch tool call was not persisted: ${err instanceof Error ? err.message : String(err)}`,
        };
        yield event;
      }
    }
  }

  private async recordPatchToolCallsFromResponse(
    response: AIResponse,
    request: AIRequest,
  ): Promise<AIResponse> {
    if (!this.patchService) {
      return response;
    }

    const toolCalls = toolCallsFromMetadata(response.metadata?.toolCalls)
      .filter((toolCall) => toolCall.name === AI_PATCH_TOOL_NAME);
    if (!toolCalls.length) {
      return response;
    }

    const patchIds: string[] = [];
    const warnings = [...(response.warnings ?? [])];
    for (const toolCall of toolCalls) {
      try {
        const patch = await this.persistPatchToolCall(toolCall, request);
        patchIds.push(patch.id);
      } catch (err) {
        warnings.push(`Patch tool call was not persisted: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      ...response,
      warnings,
      metadata: {
        ...response.metadata,
        patchIds,
      },
    };
  }

  private persistPatchToolCall(toolCall: AIToolCall, request: AIRequest) {
    if (!this.patchService) {
      throw new Error('Patch service is not configured');
    }

    return this.patchService.createFromToolCall({
      toolCall,
      sessionId: request.context.sessionId,
      fallbackFilePath: request.context.activeFilePath,
    });
  }

  private async recordRoleMemory(
    collaboration: CollaborationRequest,
    output: CollaborationRoleOutput,
  ): Promise<void> {
    const record: MemoryRecord = {
      id: output.id,
      sessionId: collaboration.context.sessionId,
      kind: output.role === 'synthesizer' ? 'handoff' : 'observation',
      summary: `${output.role}: ${output.summary}`,
      detail: output.content,
      source: 'model-gateway.collaboration',
      timestamp: output.completedAt,
      metadata: {
        collaborationId: collaboration.id,
        role: output.role,
        status: output.status,
        providerId: output.providerId,
        modelId: output.modelId,
        artifacts: output.artifacts,
      },
    };

    await this.sessionStore.addMemory(collaboration.context.sessionId, record);
    this.cacheOrchestrator.invalidate({
      type: 'session.memory.changed',
      namespace: 'context-packet',
      scope: 'session',
      scopeId: collaboration.context.sessionId,
    });
  }

  private async getOrBuildContextPacket(
    request: AIRequest,
    taskState: TaskState,
  ): Promise<Awaited<ReturnType<ContextBuilderService['buildPacket']>>> {
    const packet = await this.cacheOrchestrator.getOrBuild({
      namespace: 'context-packet',
      version: 'v1',
      scope: 'session',
      scopeId: request.context.sessionId,
      ttlMs: 60_000,
      parts: [
        request.context.workspaceId,
        request.context.sessionId,
        request.kind,
        request.prompt,
        request.context.activeFilePath ?? '',
        request.context.selectedText ?? '',
        request.context.gitDiff ?? '',
        request.context.terminalOutput ?? '',
        request.context.repoSummary ?? '',
        request.context.openFiles ?? [],
        request.context.metadata ?? {},
        taskState.goal,
        taskState.decisions,
        taskState.constraints,
        taskState.lastHandoffSummary,
        taskState.memory.map((item) => ({ id: item.id, summary: item.summary, kind: item.kind })),
        taskState.patches.map((item) => ({ id: item.patchId, status: item.status, summary: item.summary })),
      ],
    }, async () => this.contextBuilder.buildPacket(request, taskState));

    return packet as Awaited<ReturnType<ContextBuilderService['buildPacket']>>;
  }

  private buildCollaborationHandoff(
    collaboration: CollaborationRequest,
    outputs: CollaborationRoleOutput[],
  ): string {
    const lines = [`Collaboration ${collaboration.id}: ${collaboration.goal}`];
    for (const output of outputs) {
      lines.push(`- ${output.role} (${output.status}): ${output.summary}`);
    }
    return lines.join('\n');
  }

  private async recordCollaborationObsidianMemory(
    collaboration: CollaborationRequest,
    outputs: CollaborationRoleOutput[],
    finalOutput: CollaborationRoleOutput,
  ): Promise<string | undefined> {
    try {
      const saved = await this.workspace.writeObsidianMemoryNote({
        title: `Agent Session ${collaboration.id}`,
        sessionId: collaboration.context.sessionId,
        summary: finalOutput.summary,
        tags: ['ai/memory/session'],
        content: [
          `Task goal: ${collaboration.goal}`,
          '',
          '## Final Output',
          '',
          finalOutput.content,
          '',
          '## Role Outputs',
          '',
          ...outputs.flatMap((output) => [
            `### ${output.role}`,
            '',
            `Status: ${output.status}`,
            '',
            output.content,
            '',
          ]),
        ].join('\n'),
      });
      this.traceService.logHandoff(collaboration.context.sessionId, 'memory', {
        event: 'obsidian_memory_written',
        filePath: saved.filePath,
        bytes: saved.bytes,
      });
      return saved.filePath;
    } catch (err) {
      this.traceService.logError(collaboration.context.sessionId, 'memory', {
        message: err instanceof Error ? err.message : String(err),
        code: 'OBSIDIAN_MEMORY_WRITE_FAILED',
        retryable: false,
      });
      return undefined;
    }
  }
}

function findLastRoleOutput(
  outputs: CollaborationRoleOutput[],
  role: CollaborationRoleOutput['role'],
): CollaborationRoleOutput | undefined {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    if (outputs[index].role === role) {
      return outputs[index];
    }
  }
  return undefined;
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function isRoleSpec(value: CollaborationRoleSpec | undefined): value is CollaborationRoleSpec {
  return Boolean(value);
}

function shouldAttachPatchTool(request: AIRequest): boolean {
  return request.kind === 'edit' || request.kind === 'refactor';
}

function toolCallsFromMetadata(value: unknown): AIToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isToolCall);
}

function isToolCall(value: unknown): value is AIToolCall {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AIToolCall>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    !!candidate.arguments &&
    typeof candidate.arguments === 'object' &&
    !Array.isArray(candidate.arguments)
  );
}

function providerIdsFromMetadata(value: unknown): ProviderId[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const providerIds = value.filter(isProviderId);
  return providerIds.length ? providerIds : undefined;
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === 'anthropic' ||
    value === 'openai' ||
    value === 'gemini' ||
    value === 'mistral' ||
    value === 'deepseek' ||
    value === 'ollama' ||
    value === 'vllm' ||
    value === 'opencode-go' ||
    value === 'custom'
  );
}
