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
};
