import { randomUUID } from 'node:crypto';

import type {
  AgentRun,
  AgentRunCreateRequest,
  AgentRunStatus,
  AgentRunStep,
  AgentRunToolName,
  AgentRunToolRequest,
  AgentRunToolResult,
  PatchCreateRequest,
  PatchRecord,
} from '@ide/protocol';

import type { AIController } from './controller';

interface AgentRunServiceOptions {
  controller: AIController;
  maxSteps?: number;
}

export class AgentRunService {
  private runs: Map<string, AgentRun> = new Map();
  private readonly maxSteps: number;

  constructor(private readonly options: AgentRunServiceOptions) {
    this.maxSteps = options.maxSteps ?? 10;
  }

  async create(request: AgentRunCreateRequest): Promise<AgentRun> {
    const sessionId = request.sessionId.trim();
    const goal = request.goal.trim();
    if (!sessionId) {
      throw new Error('Agent run sessionId is required');
    }
    if (!goal) {
      throw new Error('Agent run goal is required');
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    const run: AgentRun = {
      runId,
      sessionId,
      goal,
      status: 'queued',
      steps: [],
      currentStepIndex: -1,
      createdAt: now,
      updatedAt: now,
      metadata: {
        toolCalls: 0,
        patchesCreated: [],
        filesRead: [],
      },
    };
    this.runs.set(runId, run);
    return run;
  }

  get(runId: string): AgentRun | null {
    return this.runs.get(runId) ?? null;
  }

  list(sessionId?: string): AgentRun[] {
    const all = [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!sessionId) return all;
    return all.filter((r) => r.sessionId === sessionId);
  }

  async cancel(runId: string, reason?: string): Promise<AgentRun | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return run;
    }
    run.status = 'cancelled';
    run.error = reason ?? 'Cancelled by user';
    run.updatedAt = new Date().toISOString();
    return run;
  }

  async execute(runId: string, toolRequests: AgentRunToolRequest[]): Promise<AgentRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== 'queued' && run.status !== 'paused') {
      throw new Error(`Cannot execute run with status: ${run.status}`);
    }
    if (!Array.isArray(toolRequests) || toolRequests.length === 0) {
      throw new Error('At least one tool request is required');
    }

    run.status = 'running';
    run.updatedAt = new Date().toISOString();

    for (const [index, toolRequest] of toolRequests.entries()) {
      if ((run.status as string) === 'cancelled') break;
      if (index >= this.maxSteps) {
        run.status = 'paused';
        run.notes = [...(run.notes ?? []), `Paused after ${this.maxSteps} steps`];
        break;
      }

      const step = await this.executeStep(runId, toolRequest);
      run.steps.push(step);
      run.currentStepIndex = run.steps.length - 1;
      run.updatedAt = new Date().toISOString();

      if (step.status === 'failed') {
        run.status = 'failed';
        run.error = step.toolResult?.error ?? 'Tool execution failed';
        break;
      }
    }

    if (run.status === 'running') {
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
    }

    return run;
  }

  private async executeStep(runId: string, toolRequest: AgentRunToolRequest): Promise<AgentRunStep> {
    const stepId = randomUUID();
    const startedAt = new Date().toISOString();
    const step: AgentRunStep = {
      id: stepId,
      type: 'tool',
      toolRequest,
      status: 'running',
      startedAt,
    };

    try {
      const result = await this.executeTool(toolRequest);
      step.toolResult = result;
      step.status = result.success ? 'completed' : 'failed';
      step.completedAt = new Date().toISOString();

      // Update metadata
      const run = this.runs.get(runId);
      if (run?.metadata) {
        run.metadata.toolCalls = (run.metadata.toolCalls ?? 0) + 1;
        if (toolRequest.tool === 'workspace.readFile' && result.success) {
          const filePath = toolRequest.params?.filePath as string;
          if (filePath && !run.metadata.filesRead?.includes(filePath)) {
            run.metadata.filesRead = [...(run.metadata.filesRead ?? []), filePath];
          }
        }
        if (toolRequest.tool === 'patch.create' && result.success) {
          const patchId = (result.result as PatchRecord)?.id;
          if (patchId) {
            run.metadata.patchesCreated = [...(run.metadata.patchesCreated ?? []), patchId];
          }
        }
      }
    } catch (err) {
      step.status = 'failed';
      step.toolResult = {
        tool: toolRequest.tool,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: new Date().toISOString(),
      };
      step.completedAt = new Date().toISOString();
    }

    return step;
  }

  private async executeTool(request: AgentRunToolRequest): Promise<AgentRunToolResult> {
    const startedAt = new Date().toISOString();
    const controller = this.options.controller;

    if (!request.tool || typeof request.tool !== 'string') {
      return {
        tool: request.tool as AgentRunToolName,
        success: false,
        error: 'Tool name is required',
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    switch (request.tool) {
      case 'obsidian.rag': {
        const { query, limit = 5 } = request.params as { query: string; limit?: number };
        const results = controller.retrieveObsidianRag(query, limit);
        return {
          tool: 'obsidian.rag',
          success: true,
          result: results,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      case 'workspace.search': {
        const { query } = request.params as { query: string };
        const results = await controller.searchWorkspaceFiles(query);
        return {
          tool: 'workspace.search',
          success: true,
          result: results,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      case 'workspace.readFile': {
        const { filePath } = request.params as { filePath: string };
        const content = await controller.readFileFromWorkspace(filePath);
        return {
          tool: 'workspace.readFile',
          success: true,
          result: { filePath, content },
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      case 'patch.create': {
        const patchRequest = request.params as unknown as PatchCreateRequest;
        const patchService = controller.getPatchService?.();
        if (!patchService) {
          return {
            tool: 'patch.create',
            success: false,
            error: 'Patch service not available',
            startedAt,
            completedAt: new Date().toISOString(),
          };
        }
        const patch = await patchService.create(patchRequest);
        return {
          tool: 'patch.create',
          success: true,
          result: patch,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      default:
        return {
          tool: request.tool as AgentRunToolName,
          success: false,
          error: `Unknown tool: ${request.tool}`,
          startedAt,
          completedAt: new Date().toISOString(),
        };
    }
  }
}
