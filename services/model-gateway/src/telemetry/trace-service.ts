import type { ProviderUsageOutcome } from '@ide/protocol';

export interface TraceStep {
  id: string;
  type: 'prompt' | 'response' | 'tool_call' | 'tool_result' | 'error' | 'retry' | 'permission' | 'workflow' | 'handoff' | 'approval';
  timestamp: string;
  agentId: string;
  sessionId: string;
  durationMs?: number;
  metadata: Record<string, unknown>;
}

export interface TracePromptStep extends TraceStep {
  type: 'prompt';
  metadata: {
    promptLength: number;
    modelId: string;
    providerId: string;
    role?: string;
    workflowNodeId?: string;
    workflowNodeLabel?: string;
    specialistAgentName?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

export interface TraceResponseStep extends TraceStep {
  type: 'response';
  metadata: {
    responseLength: number;
    tokensUsed?: number;
    finishReason?: string;
    costEstimate?: number;
    role?: string;
    workflowNodeId?: string;
    workflowNodeLabel?: string;
    specialistAgentName?: string;
  };
}

export interface TraceToolCallStep extends TraceStep {
  type: 'tool_call';
  metadata: {
    toolName: string;
    arguments: unknown;
  };
}

export interface TraceToolResultStep extends TraceStep {
  type: 'tool_result';
  metadata: {
    toolName: string;
    resultLength: number;
    success: boolean;
  };
}

export interface TraceErrorStep extends TraceStep {
  type: 'error';
  metadata: {
    message: string;
    code?: string;
    retryable: boolean;
    role?: string;
    workflowNodeId?: string;
    workflowNodeLabel?: string;
    specialistAgentName?: string;
  };
}

export interface TraceRetryStep extends TraceStep {
  type: 'retry';
  metadata: {
    attempt: number;
    maxAttempts: number;
    reason: string;
  };
}

export interface SessionTrace {
  sessionId: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  steps: TraceStep[];
  summary: {
    totalSteps: number;
    totalTokens: number;
    totalCost: number;
    totalDurationMs: number;
    toolCalls: number;
    errors: number;
    retries: number;
  };
}

export interface TraceServiceOptions {
  maxSessions?: number;
}

export class TraceService {
  private traces: Map<string, SessionTrace> = new Map();
  private maxSessions: number;

  constructor(options: TraceServiceOptions = {}) {
    this.maxSessions = options.maxSessions ?? 100;
  }

  startSession(sessionId: string, agentId: string): string {
    const trace: SessionTrace = {
      sessionId,
      agentId,
      startedAt: new Date().toISOString(),
      steps: [],
      summary: {
        totalSteps: 0,
        totalTokens: 0,
        totalCost: 0,
        totalDurationMs: 0,
        toolCalls: 0,
        errors: 0,
        retries: 0,
      },
    };
    this.traces.set(sessionId, trace);

    // Enforce max sessions
    if (this.traces.size > this.maxSessions) {
      const oldest = [...this.traces.keys()][0];
      this.traces.delete(oldest);
    }

    return sessionId;
  }

  logPrompt(sessionId: string, agentId: string, info: {
    promptLength: number;
    modelId: string;
    providerId: string;
    role?: string;
    workflowNodeId?: string;
    workflowNodeLabel?: string;
    specialistAgentName?: string;
    temperature?: number;
    maxTokens?: number;
  }): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'prompt',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      metadata: {
        promptLength: info.promptLength,
        modelId: info.modelId,
        providerId: info.providerId,
        role: info.role,
        workflowNodeId: info.workflowNodeId,
        workflowNodeLabel: info.workflowNodeLabel,
        specialistAgentName: info.specialistAgentName,
        temperature: info.temperature,
        maxTokens: info.maxTokens,
      },
    });
    return stepId;
  }

  logResponse(sessionId: string, agentId: string, info: {
    responseLength: number;
    tokensUsed?: number;
    finishReason?: string;
    durationMs: number;
    usage?: ProviderUsageOutcome;
    role?: string;
    workflowNodeId?: string;
    workflowNodeLabel?: string;
    specialistAgentName?: string;
  }): string {
    const stepId = crypto.randomUUID();
    const costEstimate = this.estimateCost(info.usage);
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'response',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      durationMs: info.durationMs,
      metadata: {
        responseLength: info.responseLength,
        tokensUsed: info.tokensUsed,
        finishReason: info.finishReason,
        costEstimate,
        role: info.role,
        workflowNodeId: info.workflowNodeId,
        workflowNodeLabel: info.workflowNodeLabel,
        specialistAgentName: info.specialistAgentName,
      },
    });
    return stepId;
  }

  logToolCall(sessionId: string, agentId: string, info: {
    toolName: string;
    arguments: unknown;
  }): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      metadata: {
        toolName: info.toolName,
        arguments: info.arguments,
      },
    });
    return stepId;
  }

  logToolResult(sessionId: string, agentId: string, info: {
    toolName: string;
    resultLength: number;
    success: boolean;
    durationMs: number;
  }): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'tool_result',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      durationMs: info.durationMs,
      metadata: {
        toolName: info.toolName,
        resultLength: info.resultLength,
        success: info.success,
      },
    });
    return stepId;
  }

  logError(sessionId: string, agentId: string, info: {
    message: string;
    code?: string;
    retryable: boolean;
    role?: string;
    workflowNodeId?: string;
    workflowNodeLabel?: string;
    specialistAgentName?: string;
  }): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'error',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      metadata: {
        message: info.message,
        code: info.code,
        retryable: info.retryable,
        role: info.role,
        workflowNodeId: info.workflowNodeId,
        workflowNodeLabel: info.workflowNodeLabel,
        specialistAgentName: info.specialistAgentName,
      },
    });
    return stepId;
  }

  logRetry(sessionId: string, agentId: string, info: {
    attempt: number;
    maxAttempts: number;
    reason: string;
  }): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'retry',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      metadata: {
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
        reason: info.reason,
      },
    });
    return stepId;
  }

  logWorkflow(sessionId: string, agentId: string, info: Record<string, unknown>): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'workflow',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      metadata: info,
    });
    return stepId;
  }

  logHandoff(sessionId: string, agentId: string, info: Record<string, unknown>): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'handoff',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      metadata: info,
    });
    return stepId;
  }

  logApproval(sessionId: string, agentId: string, info: Record<string, unknown>): string {
    const stepId = crypto.randomUUID();
    this.appendStep(sessionId, agentId, {
      id: stepId,
      type: 'approval',
      timestamp: new Date().toISOString(),
      agentId,
      sessionId,
      metadata: info,
    });
    return stepId;
  }

  endSession(sessionId: string): void {
    const trace = this.traces.get(sessionId);
    if (trace) {
      trace.endedAt = new Date().toISOString();
    }
  }

  getTrace(sessionId: string): SessionTrace | null {
    return this.traces.get(sessionId) ?? null;
  }

  getRecentTraces(limit = 10): SessionTrace[] {
    return [...this.traces.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  /** Get all trace steps across sessions that match a given workflow node ID */
  getStepsByNodeId(nodeId: string, sessionId?: string): TraceStep[] {
    const sessions = sessionId
      ? [this.traces.get(sessionId)].filter(Boolean) as SessionTrace[]
      : [...this.traces.values()];

    const steps: TraceStep[] = [];
    for (const trace of sessions) {
      for (const step of trace.steps) {
        const meta = step.metadata as Record<string, unknown>;
        if (meta.workflowNodeId === nodeId) {
          steps.push(step);
        }
      }
    }
    return steps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  getSessionCost(sessionId: string): { tokens: number; cost: number } {
    const trace = this.traces.get(sessionId);
    if (!trace) return { tokens: 0, cost: 0 };
    return {
      tokens: trace.summary.totalTokens,
      cost: trace.summary.totalCost,
    };
  }

  private appendStep(sessionId: string, agentId: string, step: TraceStep): void {
    let trace = this.traces.get(sessionId);
    if (!trace) {
      trace = {
        sessionId,
        agentId,
        startedAt: new Date().toISOString(),
        steps: [],
        summary: { totalSteps: 0, totalTokens: 0, totalCost: 0, totalDurationMs: 0, toolCalls: 0, errors: 0, retries: 0 },
      };
      this.traces.set(sessionId, trace);
    }

    trace.steps.push(step);
    trace.summary.totalSteps++;

    if (step.type === 'prompt') {
      const promptLen = (step.metadata as Record<string, number>).promptLength;
      if (promptLen) {
        const inputTokens = Math.ceil(promptLen / 4);
        trace.summary.totalTokens += inputTokens;
      }
    }

    if (step.type === 'response') {
      const meta = step.metadata as Record<string, number>;
      const responseTokens = meta.tokensUsed || Math.ceil((meta.responseLength || 0) / 4);
      trace.summary.totalTokens += responseTokens;
      trace.summary.totalCost += meta.costEstimate || 0;
      trace.summary.totalDurationMs += step.durationMs ?? 0;
    }

    if (step.type === 'tool_call') trace.summary.toolCalls++;
    if (step.type === 'error') trace.summary.errors++;
    if (step.type === 'retry') trace.summary.retries++;
  }

  private estimateCost(usage?: ProviderUsageOutcome): number {
    if (!usage) return 0;
    // Rough cost estimates per 1M tokens
    const costs: Record<string, number> = {
      'gpt-4': 30,
      'gpt-4o': 10, 'gpt-4o-mini': 0.6,
      'gpt-5': 15, 'gpt-5.1': 12, 'gpt-5.1-codex': 15,
      'claude-3-opus': 75,
      'claude-3.5-sonnet': 15, 'claude-sonnet-4': 10,
      'claude-haiku': 1.25,
      'gemini-2.5-pro': 7,
      'gemini-2.5-flash': 1.5,
      'llama': 0, 'mistral': 0, 'qwen': 0,
      'deepseek': 2, 'kimi': 8, 'glm': 2,
    };
    const baseCost = Object.entries(costs).find(([k]) => usage.modelId?.toLowerCase().includes(k))?.[1] ?? 0;
    return baseCost * 0.000001; // per token estimate
  }
}
