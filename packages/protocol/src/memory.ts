import type {
  AIRequest,
  AIRequestContext,
  AIDiagnosticSummary,
  AIRequestKind,
  AIResponse,
  AIUsage,
  ProviderId,
} from './ai';
import type { CollaborationRole } from './collaboration';
import type { ValidationResult } from './validation';

export interface MemoryRecord {
  id: string;
  sessionId: string;
  kind: 'decision' | 'patch' | 'constraint' | 'observation' | 'source' | 'handoff';
  summary: string;
  detail?: string;
  source: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface PatchMemory {
  patchId: string;
  title: string;
  filePath: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed' | 'rolled_back';
  summary: string;
  timestamp: string;
}

export interface ProviderUsageOutcome {
  requestId: string;
  providerId: ProviderId;
  modelId: string;
  success: boolean;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  errorMessage?: string;
  chosenAs: 'primary' | 'fallback';
  role?: CollaborationRole;
  taskKind?: AIRequestKind;
  collaborationId?: string;
  timestamp: string;
}

export interface ContextPacket {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  taskGoal: string;
  currentPrompt: string;
  activeFiles: Array<{ path: string; reason: string; content?: string }>;
  selectedText?: string;
  gitDiff?: string;
  diagnostics?: AIDiagnosticSummary[];
  retrievedMemory: MemoryRecord[];
  decisions: string[];
  constraints: string[];
  patchHistory: PatchMemory[];
  handoffSummary: string;
  repoSummary?: string;
  workspaceFiles?: string[];
  workspaceContext?: string;
  terminalOutput?: string;
}

export interface TaskState {
  sessionId: string;
  goal: string;
  decisions: string[];
  constraints: string[];
  patches: PatchMemory[];
  memory: MemoryRecord[];
  providerUsage: ProviderUsageOutcome[];
  lastHandoffSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextBuilder {
  buildPacket(
    request: AIRequest,
    taskState: TaskState | null,
  ): Promise<ContextPacket>;

  buildPromptWithContext(
    originalPrompt: string,
    packet: ContextPacket,
  ): string;
}

export interface SessionMemoryStore {
  getTaskState(sessionId: string): Promise<TaskState | null>;

  ensureTaskState(
    sessionId: string,
    goal: string,
  ): Promise<TaskState>;

  addDecision(
    sessionId: string,
    decision: string,
  ): Promise<void>;

  addConstraint(
    sessionId: string,
    constraint: string,
  ): Promise<void>;

  addPatchRecord(
    sessionId: string,
    patch: PatchMemory,
  ): Promise<void>;

  addMemory(
    sessionId: string,
    record: MemoryRecord,
  ): Promise<void>;

  recordProviderUsage(
    sessionId: string,
    usage: ProviderUsageOutcome,
  ): Promise<void>;

  updateHandoffSummary(
    sessionId: string,
    summary: string,
  ): Promise<void>;

  getHandoffSummary(
    sessionId: string,
  ): Promise<string>;

  listSessions(): Promise<string[]>;
}
