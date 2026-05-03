/**
 * Agent Run Types for Phase 6: Agent Execution Runtime & Tool Loop
 * Minimal local-only runtime for IDE agent workflows
 */

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunToolName =
  | 'obsidian.rag'
  | 'workspace.search'
  | 'workspace.readFile'
  | 'patch.create';

export interface AgentRunToolRequest {
  tool: AgentRunToolName;
  params: Record<string, unknown>;
}

export interface AgentRunToolResult {
  tool: AgentRunToolName;
  success: boolean;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface AgentRunStep {
  id: string;
  type: 'plan' | 'tool' | 'approval_wait' | 'summary';
  toolRequest?: AgentRunToolRequest;
  toolResult?: AgentRunToolResult;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  output?: string;
  notes?: string[];
}

export interface AgentRun {
  runId: string;
  sessionId: string;
  goal: string;
  status: AgentRunStatus;
  steps: AgentRunStep[];
  currentStepIndex: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  notes?: string[];
  metadata?: {
    toolCalls?: number;
    patchesCreated?: string[];
    filesRead?: string[];
  };
}

export interface AgentRunCreateRequest {
  sessionId: string;
  goal: string;
  maxSteps?: number;
  tools?: AgentRunToolName[];
}

export interface AgentRunListRequest {
  sessionId?: string;
  status?: AgentRunStatus;
  limit?: number;
}

export interface AgentRunCancelRequest {
  reason?: string;
}

export interface AgentRunEvent {
  type: 'run.started' | 'step.started' | 'tool.requested' | 'tool.completed' | 'run.completed' | 'run.failed' | 'run.cancelled';
  runId: string;
  stepId?: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}
