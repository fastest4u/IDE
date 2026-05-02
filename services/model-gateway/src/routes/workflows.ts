import type { FastifyPluginAsync } from 'fastify';
import type { CollaborationWorkflowInput, WorkflowApprovalDecision } from '@ide/protocol';

import type { AIController } from '../controller';

interface WorkflowRoutesOptions {
  controller: AIController;
}

export const registerWorkflowRoutes: FastifyPluginAsync<WorkflowRoutesOptions> = async (app, options) => {
  const controller = options.controller;

  // ─── Workflow CRUD ─────────────────────────────────

  app.get('/workflows', async () => ({ workflows: controller.listWorkflows() }));

  app.post('/workflows', async (request, reply) => {
    if (!request.body || typeof request.body !== 'object') {
      return reply.code(400).send({ code: 'WORKFLOW_BODY_REQUIRED', message: 'Workflow request body is required' });
    }

    try {
      const workflow = controller.saveWorkflow(request.body as CollaborationWorkflowInput);
      return reply.code(201).send({ workflow, workflows: controller.listWorkflows() });
    } catch (err) {
      return reply.code(400).send({
        code: 'WORKFLOW_SAVE_FAILED',
        message: err instanceof Error ? err.message : 'Workflow save failed',
      });
    }
  });

  app.delete('/workflows/:workflowId', async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    try {
      controller.deleteWorkflow(workflowId);
      return reply.code(200).send({ deleted: workflowId, workflows: controller.listWorkflows() });
    } catch (err) {
      return reply.code(400).send({
        code: 'WORKFLOW_DELETE_FAILED',
        message: err instanceof Error ? err.message : 'Delete failed',
      });
    }
  });

  // ─── Workflow versioning ──────────────────────────

  app.get('/workflows/:workflowId/versions', async (request) => {
    const { workflowId } = request.params as { workflowId: string };
    const versions = controller.getWorkflowVersions(workflowId);
    return { versions };
  });

  app.post('/workflows/:workflowId/rollback', async (request, reply) => {
    const { workflowId } = request.params as { workflowId: string };
    const body = (request.body ?? {}) as { version?: number };
    if (typeof body.version !== 'number') {
      return reply.code(400).send({ code: 'VERSION_REQUIRED', message: 'Target version number is required' });
    }
    try {
      const workflow = controller.rollbackWorkflow(workflowId, body.version);
      return { workflow, workflows: controller.listWorkflows() };
    } catch (err) {
      return reply.code(400).send({
        code: 'ROLLBACK_FAILED',
        message: err instanceof Error ? err.message : 'Rollback failed',
      });
    }
  });

  // ─── Workflow runs ─────────────────────────────────

  app.get('/workflows/:workflowId/runs', async (request) => {
    const { workflowId } = request.params as { workflowId: string };
    const runs = controller.listWorkflowRuns(workflowId);
    return { runs };
  });

  app.get('/workflows/runs', async () => {
    const runs = controller.listWorkflowRuns();
    return { runs };
  });

  app.get('/workflows/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = controller.getWorkflowRun(runId);
    if (!run) {
      return reply.code(404).send({ code: 'RUN_NOT_FOUND', message: `Run ${runId} not found` });
    }
    return { run };
  });

  // ─── Approval actions ─────────────────────────────

  app.post('/workflows/runs/:runId/approve', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = (request.body ?? {}) as Partial<WorkflowApprovalDecision>;

    try {
      const run = await controller.approveWorkflowRun(runId, body.nodeId, body.reason);
      return { run };
    } catch (err) {
      return reply.code(400).send({
        code: 'APPROVAL_FAILED',
        message: err instanceof Error ? err.message : 'Approval failed',
      });
    }
  });

  app.post('/workflows/runs/:runId/reject', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = (request.body ?? {}) as Partial<WorkflowApprovalDecision>;

    try {
      const run = await controller.rejectWorkflowRun(runId, body.nodeId, body.reason);
      return { run };
    } catch (err) {
      return reply.code(400).send({
        code: 'REJECTION_FAILED',
        message: err instanceof Error ? err.message : 'Rejection failed',
      });
    }
  });

  // ─── Cancel a running/paused run ──────────────────

  app.post('/workflows/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      const run = controller.cancelWorkflowRun(runId);
      return { run };
    } catch (err) {
      return reply.code(400).send({
        code: 'CANCEL_FAILED',
        message: err instanceof Error ? err.message : 'Cancel failed',
      });
    }
  });

  // ─── SSE stream of run events ─────────────────────

  app.get('/workflows/runs/:runId/stream', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = controller.getWorkflowRun(runId);
    if (!run) {
      return reply.code(404).send({ code: 'RUN_NOT_FOUND', message: `Run ${runId} not found` });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current state immediately
    reply.raw.write(`data: ${JSON.stringify({ type: 'snapshot', run })}\n\n`);

    // If already terminal, close
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      return;
    }

    // Subscribe to engine events
    const unsub = controller.onWorkflowEvent((event) => {
      if (event.runId !== runId) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch { /* client disconnected */ }

      if (event.type === 'run_completed' || event.type === 'run_failed') {
        reply.raw.write('data: [DONE]\n\n');
        try { reply.raw.end(); } catch { /* already closed */ }
        unsub();
      }
    });

    // Cleanup on client disconnect
    request.raw.on('close', () => {
      unsub();
      try { reply.raw.end(); } catch { /* already closed */ }
    });
  });
};
