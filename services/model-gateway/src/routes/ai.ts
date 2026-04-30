import type { FastifyPluginAsync } from 'fastify';

import type { AIController } from '../controller';
import type {
  AIRequest,
  CollaborationRequest,
  ProviderEmbedRequest,
  ProviderRerankRequest,
} from '@ide/protocol';

interface AIRoutesOptions {
  controller: AIController;
}

export const registerAIRoutes: FastifyPluginAsync<AIRoutesOptions> = async (app, options) => {
  const controller = options.controller;

  app.post('/ai/generate', async (request) => {
    const body = request.body as AIRequest;
    return controller.handleGenerate(body);
  });

  app.post('/ai/stream', async (request, reply) => {
    const body = request.body as AIRequest;
    const stream = await controller.handleStream(body);

    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');

    for await (const event of stream) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    reply.raw.end();
    return reply;
  });

  app.post('/ai/collaborate', async (request) => {
    const body = request.body as CollaborationRequest;
    return controller.handleCollaborate(body);
  });

  app.post('/ai/embed', async (request) => {
    const body = request.body as ProviderEmbedRequest;
    return controller.handleEmbed(body);
  });

  app.post('/ai/rerank', async (request) => {
    const body = request.body as ProviderRerankRequest;
    return controller.handleRerank(body);
  });
};
