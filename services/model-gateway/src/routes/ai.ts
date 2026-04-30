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

  app.post('/ai/generate', async (request, reply) => {
    if (!isAIRequest(request.body)) {
      return reply.code(400).send({ code: 'AI_REQUEST_INVALID', message: 'AI request body is invalid' });
    }
    const body = request.body;
    return controller.handleGenerate(body);
  });

  app.post('/ai/stream', async (request, reply) => {
    if (!isAIRequest(request.body)) {
      return reply.code(400).send({ code: 'AI_REQUEST_INVALID', message: 'AI request body is invalid' });
    }
    const abortController = new AbortController();
    request.raw.on('close', () => abortController.abort());
    const body = request.body;
    const stream = await controller.handleStream(body, { signal: abortController.signal });

    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');

    try {
      for await (const event of stream) {
        if (abortController.signal.aborted) break;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    }
    return reply;
  });

  app.post('/ai/collaborate', async (request, reply) => {
    if (!isCollaborationRequest(request.body)) {
      return reply.code(400).send({ code: 'COLLABORATION_REQUEST_INVALID', message: 'Collaboration request body is invalid' });
    }
    const body = request.body as CollaborationRequest;
    return controller.handleCollaborate(body);
  });

  app.post('/ai/embed', async (request, reply) => {
    if (!request.body || typeof request.body !== 'object') {
      return reply.code(400).send({ code: 'EMBED_REQUEST_INVALID', message: 'Embed request body is invalid' });
    }
    const body = request.body as ProviderEmbedRequest;
    return controller.handleEmbed(body);
  });

  app.post('/ai/rerank', async (request, reply) => {
    if (!request.body || typeof request.body !== 'object') {
      return reply.code(400).send({ code: 'RERANK_REQUEST_INVALID', message: 'Rerank request body is invalid' });
    }
    const body = request.body as ProviderRerankRequest;
    return controller.handleRerank(body);
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAIRequest(value: unknown): value is AIRequest {
  if (!isRecord(value) || !isRecord(value.context)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.prompt === 'string' &&
    typeof value.context.workspaceId === 'string' &&
    typeof value.context.sessionId === 'string'
  );
}

function isCollaborationRequest(value: unknown): value is CollaborationRequest {
  if (!isRecord(value) || !isRecord(value.context)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.goal === 'string' &&
    typeof value.context.workspaceId === 'string' &&
    typeof value.context.sessionId === 'string'
  );
}
