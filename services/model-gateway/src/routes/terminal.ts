import { type FastifyPluginAsync, type FastifyRequest } from 'fastify';
import { TerminalSessionService } from '../terminal/terminal-session';

export interface TerminalRouteOptions {
  terminalService: TerminalSessionService;
}

interface CreateSessionBody {
  command: string;
}

interface WriteBody {
  data: string;
}

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (trimmed.length > 5000) return false;
  return !/[\0\r\u2028\u2029]/.test(trimmed);
}

export const registerTerminalRoutes: FastifyPluginAsync<TerminalRouteOptions> = async (app, opts) => {
  const { terminalService } = opts;

  app.post('/terminal/exec', async (request: FastifyRequest<{ Body: CreateSessionBody }>, reply) => {
    const { command } = request.body ?? {};
    if (!command?.trim() || !isSafeCommand(command)) {
      return reply.status(400).send({ error: 'Command is required and must be safe' });
    }

    try {
      const session = terminalService.createSession(command.trim());
      return reply.status(201).send({ session: session.getInfo() });
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Failed to create terminal session' });
    }
  });

  app.get('/terminal/sessions', async (_request, reply) => {
    return reply.send({ sessions: terminalService.listSessions() });
  });

  app.get<{ Params: { sessionId: string } }>(
    '/terminal/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = terminalService.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Terminal session not found' });
      }

      return reply.send({ session: session.getInfo(), output: session.getOutput() });
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    '/terminal/:sessionId/stream',
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = terminalService.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Terminal session not found' });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(`data: ${JSON.stringify({ type: 'start', sessionId })}\n\n`);

      const onOutput = (text: string) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'output', text })}\n\n`);
      };

      const onExit = (code: number | null) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'exit', code })}\n\n`);
        reply.raw.end();
      };

      session.on('output', onOutput);
      session.on('exit', onExit);

      request.raw.on('close', () => {
        session.removeListener('output', onOutput);
        session.removeListener('exit', onExit);
        reply.raw.end();
      });

      return reply;
    },
  );

  app.get('/terminal/output', async (_request, reply) => {
    return reply.send({ output: terminalService.getAllOutput() });
  });

  app.post<{ Params: { sessionId: string }; Body: WriteBody }>(
    '/terminal/:sessionId/write',
    async (request, reply) => {
      const { sessionId } = request.params;
      const { data } = request.body ?? {};
      const session = terminalService.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Terminal session not found' });
      }

      if (!data || data.length > 4096) {
        return reply.status(400).send({ error: 'Input data is required and must be under 4096 characters' });
      }

      session.write(data);
      return reply.send({ sessionId, written: true });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/terminal/:sessionId/kill',
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = terminalService.getSession(sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Terminal session not found' });
      }

      session.kill();
      return reply.send({ sessionId, killed: true });
    },
  );

  app.post<{ Params: { sessionId: string }; Body: CreateSessionBody }>(
    '/terminal/:sessionId/restart',
    async (request, reply) => {
      const { sessionId } = request.params;
      const { command } = request.body ?? {};
      const existing = terminalService.getSession(sessionId);
      if (!existing && !command?.trim()) {
        return reply.status(404).send({ error: 'Terminal session not found' });
      }

      if (existing) {
        existing.kill();
      }

      const cmd = command?.trim() ?? existing?.command;
      if (!cmd || !isSafeCommand(cmd)) {
        return reply.status(400).send({ error: 'Command is required to restart and must be safe' });
      }

      try {
        const session = terminalService.createSession(cmd);
        return reply.status(201).send({ session: session.getInfo() });
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Failed to restart terminal session' });
      }
    },
  );
};
