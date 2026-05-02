import type { FastifyPluginAsync } from 'fastify';

import type { AIController } from '../controller';

interface TraceRoutesOptions {
  controller: AIController;
}

export const registerTraceRoutes: FastifyPluginAsync<TraceRoutesOptions> = async (app, options) => {
  const controller = options.controller;

  app.get('/trace/sessions', async () => {
    const traces = controller.getTraceService().getRecentTraces(20);
    return { traces };
  });

  app.get('/trace/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const trace = controller.getTraceService().getTrace(sessionId);
    if (!trace) {
      return reply.code(404).send({ code: 'TRACE_NOT_FOUND', message: `No trace for session ${sessionId}` });
    }
    return { trace };
  });

  // Per-node trace steps (trace binding)
  app.get('/trace/nodes/:nodeId', async (request) => {
    const { nodeId } = request.params as { nodeId: string };
    const { sessionId } = (request.query ?? {}) as { sessionId?: string };
    const steps = controller.getTraceService().getStepsByNodeId(nodeId, sessionId);
    return { nodeId, steps };
  });
};
