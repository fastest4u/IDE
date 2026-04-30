import type { FastifyPluginAsync } from 'fastify';

import type { AIController } from '../controller';

interface SessionRoutesOptions {
  controller: AIController;
}

export const registerSessionRoutes: FastifyPluginAsync<SessionRoutesOptions> = async (
  app,
  options,
) => {
  const controller = options.controller;

  app.get('/sessions', async () => {
    const sessions = await controller.listSessions();
    return { sessions };
  });

  app.get('/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const state = await controller.getSessionState(sessionId);
    if (!state) {
      return { sessionId, state: null };
    }
    return {
      sessionId,
      state: {
        goal: state.goal,
        decisions: state.decisions,
        constraints: state.constraints,
        patches: state.patches,
        providerUsage: state.providerUsage,
        lastHandoffSummary: state.lastHandoffSummary,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      },
    };
  });

  app.post('/sessions/:sessionId/decision', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { decision } = request.body as { decision: string };
    if (!decision) {
      return reply.code(400).send({ message: 'decision is required' });
    }
    await controller.addDecision(sessionId, decision);
    return { sessionId, decision };
  });

  app.post('/sessions/:sessionId/constraint', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { constraint } = request.body as { constraint: string };
    if (!constraint) {
      return reply.code(400).send({ message: 'constraint is required' });
    }
    await controller.addConstraint(sessionId, constraint);
    return { sessionId, constraint };
  });
};
