import type {
  AIRequestContext,
  AIResponse,
  AIUsage,
  AIToolCall,
  AIToolCallSpec,
  ModelCapabilities,
  ProviderHealth,
  ProviderId,
  AIStreamEvent,
} from './ai';

export interface ProviderInitOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  metadata?: Record<string, unknown>;
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
