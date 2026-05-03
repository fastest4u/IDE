import { type FastifyPluginAsync, type FastifyRequest } from 'fastify';
import type { AIController } from '../controller';
import { TerminalSessionService } from '../terminal/terminal-session';
import type { ToolApprovalService } from '../tool-approvals';

export interface TerminalRouteOptions {
  terminalService: TerminalSessionService;
  controller?: Pick<AIController, 'checkPermission'>;
  approvalService?: ToolApprovalService;
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

function terminalPermissionError(
  controller: TerminalRouteOptions['controller'],
  command?: string,
): { statusCode: 403 | 409; code: string; message: string; requiresApproval: boolean } | null {
  if (!controller) return null;
  const permission = command
    ? controller.checkPermission('bash', command)
    : controller.checkPermission('bash');
  if (permission.denied) {
    return {
      statusCode: 403,
      code: 'TERMINAL_COMMAND_DENIED',
      message: 'Terminal command is denied by policy',
      requiresApproval: false,
    };
  }
  if (permission.requiresAsk) {
    return {
      statusCode: 409,
      code: 'TERMINAL_COMMAND_REQUIRES_APPROVAL',
      message: 'Terminal command requires approval by policy before execution',
      requiresApproval: true,
    };
  }
  return null;
}

export const registerTerminalRoutes: FastifyPluginAsync<TerminalRouteOptions> = async (app, opts) => {
  const { terminalService, controller, approvalService } = opts;

  app.post('/terminal/exec', async (request: FastifyRequest<{ Body: CreateSessionBody }>, reply) => {
    const { command } = request.body ?? {};
    if (!command?.trim() || !isSafeCommand(command)) {
      return reply.status(400).send({ error: 'Command is required and must be safe' });
    }
    const normalizedCommand = command.trim();
    const permissionError = terminalPermissionError(controller, normalizedCommand);
    if (permissionError) {
      if (permissionError.requiresApproval && approvalService) {
        const approval = await approvalService.create({
          tool: 'terminal',
          action: 'terminal.exec',
          summary: `Run terminal command: ${normalizedCommand}`,
          command: normalizedCommand,
          cwd: terminalService.getWorkspaceRoot(),
        });
        return reply.status(202).send({
          code: permissionError.code,
          error: permissionError.message,
          approval,
        });
      }
      return reply.status(permissionError.statusCode).send({
        code: permissionError.code,
        error: permissionError.message,
      });
    }

    try {
      const session = terminalService.createSession(normalizedCommand);
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
    return reply.send({ output: terminalService.getAllOutput(), sessions: terminalService.listSessions() });
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
      const permissionError = terminalPermissionError(controller);
      if (permissionError) {
        return reply.status(permissionError.statusCode).send({
          code: permissionError.code,
          error: permissionError.message,
        });
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

      const cmd = command?.trim() ?? existing?.command;
      if (!cmd || !isSafeCommand(cmd)) {
        return reply.status(400).send({ error: 'Command is required to restart and must be safe' });
      }
      const permissionError = terminalPermissionError(controller, cmd);
      if (permissionError) {
        if (permissionError.requiresApproval && approvalService) {
          const approval = await approvalService.create({
            tool: 'terminal',
            action: 'terminal.restart',
            summary: `Restart terminal command: ${cmd}`,
            command: cmd,
            cwd: terminalService.getWorkspaceRoot(),
            targetSessionId: existing?.id ?? sessionId,
          });
          return reply.status(202).send({
            code: permissionError.code,
            error: permissionError.message,
            approval,
          });
        }
        return reply.status(permissionError.statusCode).send({
          code: permissionError.code,
          error: permissionError.message,
        });
      }

      if (existing) {
        existing.kill();
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
