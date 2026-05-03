import type { FastifyPluginAsync } from 'fastify';

import type { AIController } from '../controller';

interface MemoryRoutesOptions {
  controller: AIController;
}

export const registerMemoryRoutes: FastifyPluginAsync<MemoryRoutesOptions> = async (app, options) => {
  const controller = options.controller;

  app.get('/memory/obsidian/stats', async () => ({
    obsidian: controller.getObsidianMemoryStats(),
  }));

  app.get('/memory/obsidian/database', async (request) => {
    const query = (request.query ?? {}) as { collection?: string; type?: string; status?: string };
    const collection = typeof query.collection === 'string' && query.collection.trim() ? query.collection.trim() : undefined;
    const type = typeof query.type === 'string' && query.type.trim() ? query.type.trim() : undefined;
    const status = typeof query.status === 'string' && query.status.trim() ? query.status.trim() : undefined;
    const records = await controller.listObsidianDatabaseRecords({ collection, type, status });
    return { records };
  });

  app.post('/memory/obsidian/search', async (request, reply) => {
    const body = (request.body ?? {}) as { query?: unknown };
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return reply.code(400).send({ code: 'OBSIDIAN_QUERY_REQUIRED', message: 'query is required' });
    }

    return {
      query,
      notes: controller.searchObsidianMemory(query),
    };
  });

  app.post('/memory/obsidian/rag', async (request, reply) => {
    const body = (request.body ?? {}) as { query?: unknown; limit?: unknown };
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return reply.code(400).send({ code: 'OBSIDIAN_RAG_QUERY_REQUIRED', message: 'query is required' });
    }
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit)
      ? Math.min(20, Math.max(1, Math.floor(body.limit)))
      : 8;

    return {
      query,
      results: controller.retrieveObsidianRag(query, limit),
    };
  });
};
