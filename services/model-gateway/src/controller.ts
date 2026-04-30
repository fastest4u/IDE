import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  AIToolCall,
  CollaborationRequest,
  CollaborationResponse,
  CollaborationRoleOutput,
  MemoryRecord,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderId,
  ProviderRerankRequest,
  ProviderRerankResponse,
  ProviderRuntimeStatus,
  ProviderUsageOutcome,
  TaskState,
} from '@ide/protocol';
import {
  AI_PATCH_TOOL_INSTRUCTIONS,
  AI_PATCH_TOOL_NAME,
  AI_PATCH_TOOL_SPEC,
} from '@ide/protocol';

import { ContextBuilderService, RoleOrchestrationService } from '@ide/ai-core';

import { AIRouterEngine } from './router/ai-router';
import { ResponseValidator } from './safety/response-validator';
import { UsageLog } from './telemetry/usage-log';
import { InMemorySessionStore } from './memory/session-store';
import { WorkspaceContextService } from './memory/workspace-context';
import type { PatchService } from './patches';
import type { LocalFirstSettingsService } from './settings';

export class AIController {
  constructor(
    private readonly router: AIRouterEngine,
    private readonly contextBuilder: ContextBuilderService = new ContextBuilderService(),
    private readonly sessionStore: InMemorySessionStore = new InMemorySessionStore(),
    private readonly workspace: WorkspaceContextService = new WorkspaceContextService(),
    private readonly validator: ResponseValidator = new ResponseValidator(),
    private readonly patchService?: PatchService,
    private readonly roleOrchestrator: RoleOrchestrationService = new RoleOrchestrationService(),
    private readonly settingsService?: LocalFirstSettingsService,
  ) {}

  async handleGenerate(request: AIRequest): Promise<AIResponse> {
    const enrichedRequest = this.applyLocalPolicy(
      this.withPatchTooling(await this.enrichWithWorkspace(request)),
    );
    await this.ensureLocalOnlyRuntimeReady(enrichedRequest);

    const taskState = await this.sessionStore.ensureTaskState(
      enrichedRequest.context.sessionId,
      enrichedRequest.prompt,
    );

    const packet = await this.contextBuilder.buildPacket(enrichedRequest, taskState);
    const augmentedPrompt = this.contextBuilder.buildPromptWithContext(
      enrichedRequest.prompt,
      packet,
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

    const decision = await this.router.route(augmentedRequest);
    const response = await this.router.execute(augmentedRequest, decision);
    await this.validator.validateResponse(response);
    const responseWithPatches = await this.recordPatchToolCallsFromResponse(response, augmentedRequest);

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
    await this.sessionStore.updateHandoffSummary(
      request.context.sessionId,
      this.contextBuilder.buildHandoffSummary(taskState),
    );

    return {
      ...responseWithPatches,
      metadata: {
        ...responseWithPatches.metadata,
        sessionId: request.context.sessionId,
        taskGoal: taskState.goal,
        handoffSummary: taskState.lastHandoffSummary,
        outcome,
      },
    };
  }

  async handleStream(request: AIRequest): Promise<AsyncIterable<AIStreamEvent>> {
    const policyRequest = this.applyLocalPolicy(
      this.withPatchTooling(await this.enrichWithWorkspace(request)),
    );
    await this.ensureLocalOnlyRuntimeReady(policyRequest);
    const taskState = await this.sessionStore.ensureTaskState(
      policyRequest.context.sessionId,
      policyRequest.prompt,
    );

    const packet = await this.contextBuilder.buildPacket(policyRequest, taskState);
    const augmentedPrompt = this.contextBuilder.buildPromptWithContext(
      policyRequest.prompt,
      packet,
    );

    const augmentedRequest: AIRequest = { ...policyRequest, prompt: augmentedPrompt };

    const decision = await this.router.route(augmentedRequest);
    const adapter = this.router.getAdapter(decision.chosen.providerId);
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

    const stream = await adapter.streamText({
      requestId: policyRequest.id,
      modelId: decision.chosen.modelId,
      prompt: augmentedPrompt,
      context: policyRequest.context,
      maxTokens: policyRequest.maxTokens,
      temperature: policyRequest.temperature,
      tools: policyRequest.tools,
      stream: true,
    });
    return this.recordPatchToolCalls(stream, policyRequest);
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
    const collaboration: CollaborationRequest = {
      ...request,
      kind: seedRequest.kind,
      context: enrichedRequest.context,
    };

    const taskState = await this.sessionStore.ensureTaskState(
      collaboration.context.sessionId,
      collaboration.goal,
    );
    const packet = await this.contextBuilder.buildPacket(enrichedRequest, taskState);
    const rolePlan = this.roleOrchestrator.buildRolePlan(collaboration);
    const outputs: CollaborationRoleOutput[] = [];
    const warnings: string[] = [];

    for (const roleSpec of rolePlan) {
      const startedAt = new Date().toISOString();
      const roleRequest = this.roleOrchestrator.buildRoleRequest({
        collaboration,
        roleSpec,
        packet,
        previousOutputs: outputs,
      });

      try {
        const decision = await this.router.route(roleRequest);
        const response = await this.router.execute(roleRequest, decision);
        await this.validator.validateResponse(response);

        const output = this.roleOrchestrator.buildRoleOutput({
          collaborationId: collaboration.id,
          roleSpec,
          response,
          startedAt,
          previousOutputs: outputs,
        });
        outputs.push(output);

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
      } catch (err) {
        const output = this.roleOrchestrator.buildFailureOutput({
          collaborationId: collaboration.id,
          roleSpec,
          error: err,
          startedAt,
          previousOutputs: outputs,
        });
        outputs.push(output);
        warnings.push(`${roleSpec.role} failed: ${output.summary}`);
        await this.recordRoleMemory(collaboration, output);
      }
    }

    const finalOutput = findLastRoleOutput(outputs, 'synthesizer') ?? outputs[outputs.length - 1];
    if (!finalOutput) {
      throw new Error('Collaboration produced no role outputs');
    }

    await this.sessionStore.updateHandoffSummary(
      collaboration.context.sessionId,
      this.buildCollaborationHandoff(collaboration, outputs),
    );

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

  addDecision(sessionId: string, decision: string): Promise<void> {
    return this.sessionStore.addDecision(sessionId, decision);
  }

  addConstraint(sessionId: string, constraint: string): Promise<void> {
    return this.sessionStore.addConstraint(sessionId, constraint);
  }

  async setWorkspaceRoot(rootDir: string): Promise<void> {
    await this.workspace.setWorkspaceRoot(rootDir);
  }

  getWorkspaceRoot(): string | null {
    return this.workspace.getWorkspaceRoot();
  }

  async getWorkspaceSummary(): Promise<string> {
    return this.workspace.getRepoSummary();
  }

  async searchWorkspaceFiles(query: string): Promise<Array<{ path: string; content: string }>> {
    return this.workspace.searchFiles(query);
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
    return this.workspace.writeFileContent(input);
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

    return {
      ...request,
      context: {
        ...request.context,
        repoSummary,
        ...(activeFileContent ? { selectedText: activeFileContent } : {}),
        openFiles: openFiles.length > 0 ? openFiles : filePaths.slice(0, 30),
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
    value === 'custom'
  );
}
