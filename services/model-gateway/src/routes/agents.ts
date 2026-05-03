import type { FastifyPluginAsync } from 'fastify';
import type { AgentDefinitionInput, AgentRunCreateRequest } from '@ide/protocol';

import type { AIController } from '../controller';
import type { AgentRunService } from '../agent-run';

interface AgentRoutesOptions {
  controller: AIController;
  agentRunService?: AgentRunService;
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

  // Agent Run Routes
  const agentRunService = options.agentRunService;
  if (agentRunService) {
    app.get('/agents/runs', async (request) => {
      const sessionId = (request.query as { sessionId?: string }).sessionId;
      const runs = agentRunService.list(sessionId);
      return { runs };
    });

    app.post('/agents/runs', async (request, reply) => {
      if (!request.body || typeof request.body !== 'object') {
        return reply.code(400).send({ code: 'RUN_BODY_REQUIRED', message: 'Run request body is required' });
      }

      const body = request.body as Partial<AgentRunCreateRequest>;
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
      if (!sessionId || !goal) {
        return reply.code(400).send({
          code: 'RUN_INVALID_INPUT',
          message: 'sessionId and goal are required',
        });
      }

      const run = await agentRunService.create({
        sessionId,
        goal,
        maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : undefined,
        tools: body.tools,
      });
      return reply.code(201).send({ run });
    });

    app.get('/agents/runs/:runId', async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = agentRunService.get(runId);
      if (!run) {
        return reply.code(404).send({ code: 'RUN_NOT_FOUND', message: `Run '${runId}' not found` });
      }
      return { run };
    });

    app.post('/agents/runs/:runId/cancel', async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { reason } = request.body as { reason?: string } ?? {};
      const run = await agentRunService.cancel(runId, reason);
      if (!run) {
        return reply.code(404).send({ code: 'RUN_NOT_FOUND', message: `Run '${runId}' not found` });
      }
      return { run };
    });
  }
};
