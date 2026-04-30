import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  CollaborationRequest,
  CollaborationResponse,
  ProviderEmbedRequest,
  ProviderEmbedResponse,
  ProviderRerankRequest,
  ProviderRerankResponse,
} from '@ide/protocol';

import { AIController } from './controller';

export class ModelGatewayApp {
  constructor(private readonly controller: AIController) {}

  handleGenerate(request: AIRequest): Promise<AIResponse> {
    return this.controller.handleGenerate(request);
  }

  handleStream(request: AIRequest): Promise<AsyncIterable<AIStreamEvent>> {
    return this.controller.handleStream(request);
  }

  handleCollaborate(request: CollaborationRequest): Promise<CollaborationResponse> {
    return this.controller.handleCollaborate(request);
  }

  handleEmbed(request: ProviderEmbedRequest): Promise<ProviderEmbedResponse> {
    return this.controller.handleEmbed(request);
  }

  handleRerank(request: ProviderRerankRequest): Promise<ProviderRerankResponse> {
    return this.controller.handleRerank(request);
  }
}
