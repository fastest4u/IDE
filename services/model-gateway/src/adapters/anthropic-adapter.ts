import type {
  AIRequestContext,
  AIStreamEvent,
  ModelCapabilities,
  ProviderAdapter,
  ProviderGenerateTextRequest,
  ProviderGenerateTextResponse,
  ProviderHealth,
  ProviderId,
  ProviderInitOptions,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderRerankRequest,
  ProviderRerankResponse,
} from '@ide/protocol';

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId: ProviderId = 'anthropic';
  readonly supportedModels = ['claude-opus', 'claude-sonnet'];
  readonly capabilities: ModelCapabilities = {
    tools: true,
    vision: true,
    reasoning: true,
    streaming: true,
    longContext: true,
    codeEditing: true,
    embeddings: false,
    reranking: false,
  };

  async initialize(_options: ProviderInitOptions): Promise<void> {}

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.providerId,
      healthy: true,
      latencyMs: 50,
      errorRate: 0,
      quotaRemaining: 100,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async generateText(request: ProviderGenerateTextRequest): Promise<ProviderGenerateTextResponse> {
    return {
      providerId: this.providerId,
      modelId: request.modelId,
      text: `Anthropic placeholder response for ${request.requestId}`,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        latencyMs: 0,
      },
    };
  }

  async streamText(request: ProviderGenerateTextRequest): Promise<AsyncIterable<AIStreamEvent>> {
    return (async function* () {
      yield { type: 'start', requestId: request.requestId };
      yield { type: 'delta', text: 'Anthropic stream placeholder' };
      yield { type: 'end', reason: 'complete' };
    })();
  }

  async embedText(_request: ProviderEmbedRequest): Promise<ProviderEmbedResponse> {
    return {
      providerId: this.providerId,
      modelId: 'embedding-placeholder',
      embeddings: [],
    };
  }

  async rerank(_request: ProviderRerankRequest): Promise<ProviderRerankResponse> {
    return {
      providerId: this.providerId,
      modelId: 'rerank-placeholder',
      rankedCandidates: [],
    };
  }

  supportsTools(): boolean {
    return true;
  }

  supportsVision(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }
}
