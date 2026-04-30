---
title: AI Router and Provider Interfaces
created: 2026-04-29
---

# AI Router and Provider Interfaces

This document defines the TypeScript interfaces for the provider-agnostic AI stack.

## Core types

```ts
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

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'deepseek'
  | 'ollama'
  | 'vllm'
  | 'custom';

export type ModelTier = 'fast' | 'balanced' | 'premium' | 'local';
export type RoutingStrategy = 'primary' | 'fallback' | 'localOnly' | 'costOptimized' | 'latencyOptimized';
```

## Request and context

```ts
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

export interface AIResponse {
  requestId: string;
  providerId: ProviderId;
  modelId: string;
  text?: string;
  stream?: AsyncIterable<AIStreamEvent>;
  usage?: AIUsage;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
}
```

## Routing and registry

```ts
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
```

## Provider adapter

```ts
export interface ProviderInitOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  readonly supportedModels: string[];
  readonly capabilities: ModelCapabilities;

  initialize(options: ProviderInitOptions): Promise<void>;
  healthCheck(): Promise<ProviderHealth>;

  generateText(request: ProviderGenerateTextRequest): Promise<ProviderGenerateTextResponse>;
  streamText(request: ProviderGenerateTextRequest): Promise<AsyncIterable<AIStreamEvent>>;
  embedText?(request: ProviderEmbedRequest): Promise<ProviderEmbedResponse>;
  rerank?(request: ProviderRerankRequest): Promise<ProviderRerankResponse>;
  countTokens?(input: string, modelId: string): Promise<number>;
  supportsTools?(modelId: string): boolean;
  supportsVision?(modelId: string): boolean;
  supportsStreaming?(modelId: string): boolean;
  shutdown?(): Promise<void>;
}

export interface ProviderGenerateTextRequest {
  requestId: string;
  modelId: string;
  prompt: string;
  context: AIRequestContext;
  maxTokens?: number;
  temperature?: number;
  tools?: AIToolCallSpec[];
  stream?: boolean;
}

export interface ProviderGenerateTextResponse {
  providerId: ProviderId;
  modelId: string;
  text: string;
  usage?: AIUsage;
  toolCalls?: AIToolCall[];
  metadata?: Record<string, unknown>;
}
```

## Tools and streaming

```ts
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

export interface ProviderEmbedRequest {
  modelId: string;
  input: string | string[];
  context?: AIRequestContext;
}

export interface ProviderEmbedResponse {
  providerId: ProviderId;
  modelId: string;
  embeddings: number[][];
}

export interface ProviderRerankRequest {
  modelId: string;
  query: string;
  candidates: string[];
  context?: AIRequestContext;
}

export interface ProviderRerankResponse {
  providerId: ProviderId;
  modelId: string;
  rankedCandidates: Array<{ value: string; score: number }>;
}
```

## Safety and validation

```ts
export interface SafetyPolicy {
  redactSecrets: boolean;
  allowShellCommands: boolean;
  requireApprovalForDestructiveActions: boolean;
  blockedPatterns?: RegExp[];
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export interface AIValidator {
  validateResponse(response: AIResponse): Promise<ValidationResult>;
  validateToolCall(toolCall: AIToolCall): Promise<ValidationResult>;
}
```

## Recommended call flow

```ts
export interface AIOrchestrator {
  classify(request: AIRequest): Promise<AIRequestKind>;
  buildContext(request: AIRequest): Promise<AIRequest>;
  route(request: AIRequest): Promise<RoutingDecision>;
  execute(request: AIRequest, decision: RoutingDecision): Promise<AIResponse>;
  validate(response: AIResponse): Promise<ValidationResult>;
}
```

## Notes

- Keep these interfaces stable and shared across services.
- Implement provider adapters behind the `ProviderAdapter` contract.
- Use the registry and policy engine to avoid hard-coding provider logic in the IDE UI.
- Add tests around routing and fallback behavior before connecting real provider keys.
