import type { ValidationResult } from './validation';

export type AIRequestKind =
  | 'chat'
  | 'edit'
  | 'refactor'
  | 'explain'
  | 'plan'
  | 'validate'
  | 'embed'
  | 'rerank';

export type AICapability =
  | 'tools'
  | 'vision'
  | 'reasoning'
  | 'streaming'
  | 'longContext'
  | 'codeEditing'
  | 'embeddings'
  | 'reranking';

export type ModelTier = 'fast' | 'balanced' | 'premium' | 'local';
export type RoutingStrategy =
  | 'primary'
  | 'fallback'
  | 'localOnly'
  | 'costOptimized'
  | 'latencyOptimized'
  | 'committee';

export interface AIRequestContext {
  workspaceId: string;
  sessionId: string;
  userId?: string;
  activeFilePath?: string;
  selectedText?: string;
  openFiles?: string[];
  gitDiff?: string;
  terminalOutput?: string;
  diagnostics?: AIDiagnosticSummary[];
  repoSummary?: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface AIDiagnosticSummary {
  source: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface AIRequest {
  id: string;
  kind: AIRequestKind;
  prompt: string;
  context: AIRequestContext;
  preferredCapabilities?: AICapability[];
  preferredModelTier?: ModelTier;
  strategy?: RoutingStrategy;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: AIToolCallSpec[];
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
}

export interface AIResponse {
  requestId: string;
  providerId: ProviderId;
  modelId: string;
  text?: string;
  usage?: AIUsage;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

export interface AIToolCallSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  strict?: boolean;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AIStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; toolCall: AIToolCall }
  | { type: 'usage'; usage: AIUsage }
  | { type: 'warning'; message: string }
  | { type: 'end'; reason?: string };

export interface AIOrchestrator {
  classify(request: AIRequest): Promise<AIRequestKind>;
  buildContext(request: AIRequest): Promise<AIRequest>;
  route(request: AIRequest): Promise<RoutingDecision>;
  execute(request: AIRequest, decision: RoutingDecision): Promise<AIResponse>;
  validate(response: AIResponse): Promise<ValidationResult>;
}

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'deepseek'
  | 'ollama'
  | 'vllm'
  | 'opencode-go'
  | 'custom';

export interface RoutingCandidate {
  model: ModelDescriptor;
  score: number;
  reasons: string[];
}

export interface RoutingDecision {
  requestId: string;
  chosen: ModelDescriptor;
  candidates: RoutingCandidate[];
  strategy: RoutingStrategy;
  fallbackChain: ModelDescriptor[];
  decidedAt: string;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
  longContext: boolean;
  codeEditing: boolean;
  embeddings: boolean;
  reranking: boolean;
}

export interface ModelDescriptor {
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  tier: ModelTier;
  capabilities: ModelCapabilities;
  maxContextTokens: number;
  maxOutputTokens?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
  priority?: number;
  tags?: string[];
}

export interface ProviderHealth {
  providerId: ProviderId;
  healthy: boolean;
  latencyMs?: number;
  errorRate?: number;
  quotaRemaining?: number;
  lastCheckedAt?: string;
  notes?: string[];
}

export interface ModelRegistry {
  listModels(): Promise<ModelDescriptor[]>;
  getModel(providerId: ProviderId, modelId: string): Promise<ModelDescriptor | null>;
  listByCapability(capability: AICapability): Promise<ModelDescriptor[]>;
  listHealthyModels(): Promise<ModelDescriptor[]>;
}

export interface ProviderPolicyEngine {
  score(request: AIRequest, models: ModelDescriptor[], health: ProviderHealth[]): Promise<RoutingCandidate[]>;
  choose(request: AIRequest, candidates: RoutingCandidate[]): Promise<RoutingDecision>;
}

export interface AIRouter {
  route(request: AIRequest): Promise<RoutingDecision>;
}
