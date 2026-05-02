import type { FastifyPluginAsync } from 'fastify';
import type { AgentDefinitionInput } from '@ide/protocol';

import type { AIController } from '../controller';

interface AgentRoutesOptions {
  controller: AIController;
}

export const registerAgentRoutes: FastifyPluginAsync<AgentRoutesOptions> = async (app, options) => {
  const controller = options.controller;

  app.get('/agents', async () => {
    const agents = controller.listAgents();
    return { agents, activeAgentId: controller.getActiveAgentId() };
  });

  app.post('/agents', async (request, reply) => {
    if (!request.body || typeof request.body !== 'object') {
      return reply.code(400).send({ code: 'AGENT_BODY_REQUIRED', message: 'Agent request body is required' });
    }

    try {
      const agent = controller.saveAgent(request.body as AgentDefinitionInput);
      return reply.code(201).send({ agent, agents: controller.listAgents(), activeAgentId: controller.getActiveAgentId() });
    } catch (err) {
      return reply.code(400).send({
        code: 'AGENT_SAVE_FAILED',
        message: err instanceof Error ? err.message : 'Agent save failed',
      });
    }
  });

  app.post('/agents/:agentId/activate', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = controller.getAgent(agentId);
    if (!agent || !agent.selectable) {
      return reply.code(404).send({ code: 'AGENT_NOT_FOUND', message: `Agent '${agentId}' not found or not selectable` });
    }
    controller.setActiveAgent(agentId);
    return { agent, activeAgentId: controller.getActiveAgentId() };
  });
};
