import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { PatchCreateRequest } from '@ide/protocol';

import { PatchServiceError, type PatchService } from '../patches';
import { WorkspacePathError } from '../workspace-writer';
import type { TraceService } from '../telemetry/trace-service';
import type { PatchRecord } from '@ide/protocol';

interface PatchRoutesOptions {
  patchService: PatchService;
  traceService?: TraceService;
}

export const registerPatchRoutes: FastifyPluginAsync<PatchRoutesOptions> = async (app, options) => {
  const patchService = options.patchService;

  app.get('/patches', async () => ({ patches: patchService.list() }));

  app.get('/patches/:patchId', async (request, reply) => {
    const { patchId } = request.params as { patchId: string };
    const patch = patchService.get(patchId);

    if (!patch) {
      return reply.code(404).send({ message: 'Patch not found' });
    }

    return { patch };
  });

  app.post('/patches', async (request, reply) => {
    try {
      if (!request.body || typeof request.body !== 'object') {
        throw new PatchServiceError('Patch request body is required');
      }

      const patch = await patchService.create(request.body as PatchCreateRequest);
      logPatchApproval(options.traceService, 'created', patch);
      return reply.code(201).send({ patch });
    } catch (err) {
      return sendPatchError(reply, err);
    }
  });

  app.post('/patches/:patchId/approve', async (request, reply) => {
    const { patchId } = request.params as { patchId: string };
    try {
      const patch = await patchService.approve(patchId);

      if (!patch) {
        return reply.code(404).send({ message: 'Patch not found' });
      }

      logPatchApproval(options.traceService, 'approved', patch);
      return { patch };
    } catch (err) {
      return sendPatchError(reply, err);
    }
  });

  app.post('/patches/:patchId/reject', async (request, reply) => {
    const { patchId } = request.params as { patchId: string };
    try {
      const patch = await patchService.reject(patchId);

      if (!patch) {
        return reply.code(404).send({ message: 'Patch not found' });
      }

      logPatchApproval(options.traceService, 'rejected', patch);
      return { patch };
    } catch (err) {
      return sendPatchError(reply, err);
    }
  });

  app.post('/patches/:patchId/review', async (request, reply) => {
    const { patchId } = request.params as { patchId: string };
    try {
      const patch = await patchService.review(patchId);

      if (!patch) {
        return reply.code(404).send({ message: 'Patch not found' });
      }

      logPatchApproval(options.traceService, 'reviewed', patch);
      return { patch };
    } catch (err) {
      return sendPatchError(reply, err);
    }
  });

  app.post('/patches/:patchId/apply', async (request, reply) => {
    const { patchId } = request.params as { patchId: string };
    try {
      const patch = await patchService.apply(patchId);

      if (!patch) {
        return reply.code(404).send({ message: 'Patch not found' });
      }

      logPatchApproval(options.traceService, 'applied', patch);
      return { patch };
    } catch (err) {
      return sendPatchError(reply, err);
    }
  });

  app.post('/patches/:patchId/rollback', async (request, reply) => {
    const { patchId } = request.params as { patchId: string };
    try {
      const patch = await patchService.rollback(patchId);

      if (!patch) {
        return reply.code(404).send({ message: 'Patch not found' });
      }

      logPatchApproval(options.traceService, 'rolled_back', patch);
      return { patch };
    } catch (err) {
      return sendPatchError(reply, err);
    }
  });
};

function logPatchApproval(
  traceService: TraceService | undefined,
  action: string,
  patch: PatchRecord,
) {
  traceService?.logApproval(patch.sessionId ?? 'approval-queue', 'approval', {
    action,
    patchId: patch.id,
    title: patch.title,
    status: patch.status,
    files: patch.operations.map((operation) => operation.filePath),
    reviewStatus: patch.review?.status,
  });
}

function sendPatchError(
  reply: FastifyReply,
  err: unknown,
) {
  if (err instanceof PatchServiceError) {
    return reply.code(err.statusCode).send({ code: err.code, message: err.message });
  }

  if (err instanceof WorkspacePathError) {
    return reply.code(400).send({ code: err.code, message: err.message });
  }

  throw err;
}
