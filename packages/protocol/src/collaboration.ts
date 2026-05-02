import type {
  AICapability,
  AIRequestContext,
  AIRequestKind,
  AIUsage,
  ModelTier,
  ProviderId,
  RoutingStrategy,
} from './ai';

export type CollaborationRole =
  | 'planner'
  | 'context_curator'
  | 'coder'
  | 'reviewer'
  | 'verifier'
  | 'synthesizer';

export type CollaborationTeamId =
  | 'auto'
  | 'coding_team'
  | 'research_assistant'
  | 'review_team'
  | 'planning_team'
  | 'tool_execution_team';

export type CollaborationOutputKind =
  | 'plan'
  | 'context'
  | 'patch_plan'
  | 'review'
  | 'verification'
  | 'synthesis';

export type CollaborationRoleStatus = 'completed' | 'failed' | 'skipped';

export interface CollaborationArtifact {
  kind:
    | 'file'
    | 'patch'
    | 'command'
    | 'decision'
    | 'risk'
    | 'acceptance_criteria'
    | 'observation';
  title: string;
  value?: string;
  metadata?: Record<string, unknown>;
}

export interface CollaborationRoleSpec {
  role: CollaborationRole;
  objective: string;
  expectedOutput: CollaborationOutputKind;
  workflowNodeId?: string;
  workflowNodeLabel?: string;
  specialistAgentId?: string;
  specialistAgentName?: string;
  preferredCapabilities?: AICapability[];
  preferredModelTier?: ModelTier;
  strategy?: RoutingStrategy;
}

export interface CollaborationRoleOutput {
  id: string;
  role: CollaborationRole;
  kind: CollaborationOutputKind;
  status: CollaborationRoleStatus;
  workflowNodeId?: string;
  workflowNodeLabel?: string;
  specialistAgentId?: string;
  specialistAgentName?: string;
  summary: string;
  content: string;
  artifacts: CollaborationArtifact[];
  warnings?: string[];
  providerId?: ProviderId;
  modelId?: string;
  usage?: AIUsage;
  startedAt: string;
  completedAt: string;
  inputRoleIds: string[];
}

export interface CollaborationRequest {
  id: string;
  goal: string;
  kind?: AIRequestKind;
  context: AIRequestContext;
  team?: CollaborationTeamId;
  workflowId?: string;
  roles?: CollaborationRole[];
  strategy?: RoutingStrategy;
  maxTokensPerRole?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface CollaborationWorkflowDefinition {
  id: string;
  name: string;
  description: string;
  roles: CollaborationRole[];
  graph?: CollaborationWorkflowGraph;
  team?: CollaborationTeamId;
  maxTokensPerRole?: number;
  temperature?: number;
  /** Version history of graph snapshots */
  versions?: WorkflowVersion[];
  /** Current active version number */
  currentVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollaborationWorkflowInput {
  id?: string;
  name: string;
  description?: string;
  roles: CollaborationRole[];
  graph?: CollaborationWorkflowGraph;
  team?: CollaborationTeamId;
  maxTokensPerRole?: number;
  temperature?: number;
}

export type CollaborationWorkflowNodeType =
  | 'agent'
  | 'tool'
  | 'approval'
  | 'condition'
  | 'memory'
  | 'synthesizer'
  | 'start'
  | 'end'
  | 'retry';

export type NodeFailurePolicy = 'stop' | 'skip' | 'retry' | 'fallback';

export interface CollaborationWorkflowNode {
  id: string;
  type: CollaborationWorkflowNodeType;
  label: string;
  role?: CollaborationRole;
  agentId?: string;
  toolName?: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;
  /** What to do when this node fails (default: 'stop') */
  onFailure?: NodeFailurePolicy;
  /** Target node when onFailure is 'fallback' */
  fallbackNodeId?: string;
  /** Per-node max retries (only used when onFailure is 'retry'; hard cap: 5) */
  maxRetries?: number;
}

export interface CollaborationWorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string;
  /** For condition/retry nodes: which branch this edge represents */
  branch?: 'true' | 'false' | 'retry' | 'exhaust' | 'default';
}

export interface CollaborationWorkflowGraph {
  version: 1;
  nodes: CollaborationWorkflowNode[];
  edges: CollaborationWorkflowEdge[];
}

export interface WorkflowVersion {
  version: number;
  graph: CollaborationWorkflowGraph;
  createdAt: string;
  description?: string;
}

export interface CollaborationTeamResolution {
  teamId: Exclude<CollaborationTeamId, 'auto'>;
  roles: CollaborationRole[];
  reason: string;
  autoSelected: boolean;
}

export interface CollaborationResponse {
  id: string;
  requestId: string;
  sessionId: string;
  goal: string;
  rolePlan: CollaborationRoleSpec[];
  outputs: CollaborationRoleOutput[];
  finalOutput: CollaborationRoleOutput;
  warnings?: string[];
  createdAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
  /** Present when the run was paused (e.g. at an approval node) */
  runState?: WorkflowRunState;
}

// ─── Typed node configs ───────────────────────────────────────

export interface ConditionNodeConfig {
  /** Simple expression evaluated against previous node output context */
  expression: string;
  /** Edge label/branch to follow when the expression evaluates to true */
  trueBranch: string;
  /** Edge label/branch to follow when false */
  falseBranch: string;
}

export interface RetryNodeConfig {
  /** Maximum number of retry attempts (hard cap: 5) */
  maxAttempts: number;
  /** Delay between retries in milliseconds */
  delayMs: number;
  /** Edge branch to follow when retries are exhausted */
  exhaustBranch?: string;
}

export interface ApprovalNodeConfig {
  /** Categories of actions that require this approval */
  requiredFor: string[];
  /** Optional timeout in milliseconds before auto-decision */
  timeoutMs?: number;
  /** If true, auto-approve on timeout; otherwise auto-reject */
  autoApproveOnTimeout?: boolean;
}

export interface MemoryNodeConfig {
  /** Memory action to perform */
  action: 'read' | 'write' | 'search';
  /** Query string for read/search actions */
  query?: string;
  /** Memory scope to target */
  scope?: 'session' | 'workspace' | 'obsidian';
}

// ─── Workflow run state ───────────────────────────────────────

export type WorkflowRunStatus =
  | 'running'
  | 'paused_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkflowRunNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting_approval'
  | 'approved'
  | 'rejected'
  | 'retrying';

export interface WorkflowRunNodeState {
  nodeId: string;
  status: WorkflowRunNodeStatus;
  output?: CollaborationRoleOutput;
  retryCount?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  collaborationId: string;
  status: WorkflowRunStatus;
  nodeStates: WorkflowRunNodeState[];
  outputs: CollaborationRoleOutput[];
  pausedAtNodeId?: string;
  /** Frozen copy of the graph used for this run */
  graphSnapshot?: CollaborationWorkflowGraph;
  /** Workflow version number at run start */
  workflowVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowApprovalDecision {
  runId: string;
  nodeId: string;
  decision: 'approve' | 'reject';
  reason?: string;
  decidedAt: string;
}

// ─── Runtime status events (for SSE/polling) ──────────────────

export interface WorkflowRunEvent {
  type: 'node_started' | 'node_completed' | 'node_failed' | 'node_retrying' | 'run_paused' | 'run_completed' | 'run_failed';
  runId: string;
  nodeId?: string;
  status?: WorkflowRunNodeStatus;
  error?: string;
  timestamp: string;
}
