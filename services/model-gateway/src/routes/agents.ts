import type { FastifyPluginAsync } from 'fastify';
import type { AgentConfig } from '@ide/protocol';

import type { AIController } from '../controller';

interface AgentRoutesOptions {
  controller: AIController;
}

export const registerAgentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, options) => {
  const controller = options.controller;

  // List all available agents (selectable only, or include hidden with query param)
  app.get('/agents', async (request) => {
    const query = request.query as { includeHidden?: string };
    const includeHidden = query.includeHidden === 'true';
    const agents = await controller.getAgents({ includeHidden });
    return { agents };
  });

  // Get a specific agent by ID
  app.get('/agents/:agentId', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = await controller.getAgentById(agentId);

    if (!agent) {
      return reply.code(404).send({
        code: 'AGENT_NOT_FOUND',
        message: `Agent '${agentId}' not found`,
      });
    }

    return { agent };
  });

  // Reload agents from disk (markdown files)
  app.post('/agents/reload', async () => {
    await controller.reloadAgents();
    const agents = await controller.getAgents({ includeHidden: true });
    return { agents };
  });
};
