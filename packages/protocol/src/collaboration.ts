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
  preferredCapabilities?: AICapability[];
  preferredModelTier?: ModelTier;
  strategy?: RoutingStrategy;
}

export interface CollaborationRoleOutput {
  id: string;
  role: CollaborationRole;
  kind: CollaborationOutputKind;
  status: CollaborationRoleStatus;
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
  roles?: CollaborationRole[];
  strategy?: RoutingStrategy;
  maxTokensPerRole?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
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
}
