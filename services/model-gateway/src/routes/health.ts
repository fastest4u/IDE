import type { FastifyPluginAsync } from 'fastify';

import type { AIController } from '../controller';

interface HealthRoutesOptions {
  controller: AIController;
}

export const registerHealthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const controller = options?.controller;

  app.get('/health/live', async () => ({ status: 'live' as const }));
  app.get('/health/ready', async () => ({ status: 'ready' as const }));
  app.get('/health/providers', async () => {
    if (!controller) return { providers: [] };
    return { providers: await controller.getProviderStatuses() };
  });
};
