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
      healthy: false,
      latencyMs: 0,
      errorRate: 1,
      lastCheckedAt: new Date().toISOString(),
      notes: ['Anthropic adapter is not implemented yet'],
    };
  }

  async generateText(request: ProviderGenerateTextRequest): Promise<ProviderGenerateTextResponse> {
    throw new Error(`Anthropic adapter is not implemented for request ${request.requestId}`);
  }

  async streamText(request: ProviderGenerateTextRequest): Promise<AsyncIterable<AIStreamEvent>> {
    return (async function* () {
      yield { type: 'start', requestId: request.requestId };
      yield { type: 'warning', message: 'Anthropic adapter is not implemented yet' };
      yield { type: 'end', reason: 'error' };
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
