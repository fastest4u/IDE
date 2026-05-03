import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ToolApprovalDecisionRequest, ToolApprovalStatus } from '@ide/protocol';

import { ToolApprovalError, type ToolApprovalService } from '../tool-approvals';
import type { TerminalSessionService } from '../terminal/terminal-session';

interface ToolApprovalRoutesOptions {
  approvalService: ToolApprovalService;
  terminalService: TerminalSessionService;
}

export const registerToolApprovalRoutes: FastifyPluginAsync<ToolApprovalRoutesOptions> = async (app, options) => {
  const approvalService = options.approvalService;
  const terminalService = options.terminalService;

  app.get('/tool-approvals', async (request) => {
    const query = request.query as { status?: string };
    const status = isToolApprovalStatus(query.status) ? query.status : undefined;
    return { approvals: approvalService.list(status) };
  });

  app.get('/tool-approvals/:approvalId', async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const approval = approvalService.get(approvalId);
    if (!approval) {
      return reply.code(404).send({ code: 'TOOL_APPROVAL_NOT_FOUND', message: 'Tool approval not found' });
    }
    return { approval };
  });

  app.post('/tool-approvals/:approvalId/approve', async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = (request.body ?? {}) as ToolApprovalDecisionRequest;
    try {
      const approval = await approvalService.approve(approvalId, {
        reason: body.reason,
        execute: async (record) => {
          if (record.action !== 'terminal.exec' && record.action !== 'terminal.restart') {
            return undefined;
          }
          if (!record.command) {
            throw new ToolApprovalError('Approved terminal command is missing', 400, 'TOOL_APPROVAL_COMMAND_MISSING');
          }

          if (record.action === 'terminal.restart' && record.targetSessionId) {
            terminalService.killSession(record.targetSessionId);
          }

          const session = terminalService.createSession(record.command);
          return { sessionId: session.id };
        },
      });
      if (!approval) {
        return reply.code(404).send({ code: 'TOOL_APPROVAL_NOT_FOUND', message: 'Tool approval not found' });
      }
      return { approval };
    } catch (err) {
      return sendToolApprovalError(reply, err);
    }
  });

  app.post('/tool-approvals/:approvalId/reject', async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string };
    const body = (request.body ?? {}) as ToolApprovalDecisionRequest;
    try {
      const approval = await approvalService.reject(approvalId, body.reason);
      if (!approval) {
        return reply.code(404).send({ code: 'TOOL_APPROVAL_NOT_FOUND', message: 'Tool approval not found' });
      }
      return { approval };
    } catch (err) {
      return sendToolApprovalError(reply, err);
    }
  });
};

function isToolApprovalStatus(value: unknown): value is ToolApprovalStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'expired';
}

function sendToolApprovalError(reply: FastifyReply, err: unknown) {
  if (err instanceof ToolApprovalError) {
    return reply.code(err.statusCode).send({ code: err.code, message: err.message });
  }
  return reply.code(400).send({ code: 'TOOL_APPROVAL_FAILED', message: err instanceof Error ? err.message : String(err) });
}
