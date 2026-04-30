import type { FastifyPluginAsync } from 'fastify';
import path from 'node:path';

import type { AIController } from '../controller';
import { WorkspaceFileError } from '../memory/workspace-context';
import type { PatchService } from '../patches';
import type { TerminalSessionService } from '../terminal/terminal-session';
import type { WorkspacePickerService } from '../workspace-picker';
import { WorkspacePickerError } from '../workspace-picker';
import { WorkspacePathError } from '../workspace-writer';

interface WorkspaceRoutesOptions {
  controller: AIController;
  patchService?: PatchService;
  terminalService?: TerminalSessionService;
  workspacePicker?: WorkspacePickerService;
}

interface WorkspaceSaveFileBody {
  path?: unknown;
  content?: unknown;
  expectedContent?: unknown;
}

function workspaceErrorStatus(err: unknown): number {
  if (err instanceof WorkspaceFileError) {
    switch (err.code) {
      case 'WORKSPACE_WRITE_CONFLICT':
        return 409;
      case 'WORKSPACE_INVALID_ROOT':
        return 400;
      case 'WORKSPACE_FILE_TOO_LARGE':
        return 413;
      case 'WORKSPACE_NOT_READY':
      case 'WORKSPACE_FILE_NOT_FOUND':
        return 404;
    }
  }

  if (err instanceof WorkspacePathError) {
    return 400;
  }

  if (err instanceof WorkspacePickerError) {
    switch (err.code) {
      case 'WORKSPACE_PICKER_CANCELLED':
        return 409;
      case 'WORKSPACE_PICKER_UNAVAILABLE':
        return 501;
      case 'WORKSPACE_PICKER_FAILED':
        return 500;
    }
  }

  return 500;
}

function workspaceErrorCode(err: unknown): string {
  if (err instanceof WorkspaceFileError || err instanceof WorkspacePathError || err instanceof WorkspacePickerError) {
    return err.code;
  }
  return 'WORKSPACE_ERROR';
}

function isSafeWorkspacePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return Boolean(trimmed) && !trimmed.includes('..') && !trimmed.startsWith('/') && !trimmed.includes('\0');
}

export const registerWorkspaceRoutes: FastifyPluginAsync<WorkspaceRoutesOptions> = async (
  app,
  options,
) => {
  const controller = options.controller;

  app.post('/workspace/pick', async (request, reply) => {
    if (!options.workspacePicker) {
      return reply.code(501).send({
        code: 'WORKSPACE_PICKER_UNAVAILABLE',
        message: 'Workspace picker is not configured on this gateway',
      });
    }

    const body = (request.body ?? {}) as { defaultPath?: unknown };
    if (body.defaultPath !== undefined && typeof body.defaultPath !== 'string') {
      return reply.code(400).send({ code: 'WORKSPACE_PICKER_INVALID_INPUT', message: 'defaultPath must be a string when provided' });
    }

    try {
      const rootDir = await options.workspacePicker.pickDirectory(body.defaultPath);
      return { rootDir };
    } catch (err) {
      return reply.code(workspaceErrorStatus(err)).send({
        code: workspaceErrorCode(err),
        message: err instanceof Error ? err.message : 'Workspace pick failed',
      });
    }
  });

  app.post('/workspace/index', async (request, reply) => {
    const body = (request.body ?? {}) as { rootDir?: unknown };
    const rootDir = typeof body.rootDir === 'string' ? body.rootDir : '';
    if (!rootDir?.trim()) {
      return reply.code(400).send({ message: 'rootDir is required' });
    }
    try {
      await controller.setWorkspaceRoot(rootDir);
      const normalizedRootDir = controller.getWorkspaceRoot() ?? rootDir;
      options.patchService?.setWorkspaceRoot(normalizedRootDir);
      options.terminalService?.setWorkspaceRoot(normalizedRootDir);
      const summary = await controller.getWorkspaceSummary();
      const files = await controller.getWorkspaceFiles();
      return { rootDir: normalizedRootDir, summary, fileCount: files.length };
    } catch (err) {
      return reply.code(workspaceErrorStatus(err)).send({
        code: workspaceErrorCode(err),
        message: err instanceof Error ? err.message : 'Workspace index failed',
      });
    }
  });

  app.get('/workspace/summary', async () => {
    const summary = await controller.getWorkspaceSummary();
    const files = await controller.getWorkspaceFiles();
    const rootDir = controller.getWorkspaceRoot();
    return {
      summary,
      fileCount: files.length,
      ready: controller.isWorkspaceReady(),
      rootDir,
      name: rootDir ? path.basename(rootDir) : 'No workspace',
    };
  });

  app.get('/workspace/files', async () => {
    const files = await controller.getWorkspaceFiles();
    return { files, count: files.length };
  });

  app.post('/workspace/search', async (request, reply) => {
    const body = (request.body ?? {}) as { query?: unknown };
    const query = typeof body.query === 'string' ? body.query : '';
    if (!query) {
      return reply.code(400).send({ message: 'query is required' });
    }
    const results = await controller.searchWorkspaceFiles(query);
    return { query, results: results.map((r) => ({ path: r.path })), count: results.length };
  });

  app.get('/workspace/file', async (request, reply) => {
    const { path: filePath } = request.query as { path?: string };
    if (!filePath || !isSafeWorkspacePath(filePath)) {
      return reply.code(400).send({ message: 'path query parameter is required and must be workspace-relative' });
    }
    try {
      const content = await controller.readFileFromWorkspace(filePath);
      return { filePath, content };
    } catch (err) {
      return reply.code(workspaceErrorStatus(err)).send({
        code: workspaceErrorCode(err),
        message: err instanceof Error ? err.message : 'Workspace file read failed',
      });
    }
  });

  app.put('/workspace/file', async (request, reply) => {
    const body = request.body as WorkspaceSaveFileBody;
    const filePath = body.path;
    const content = body.content;
    const expectedContent = body.expectedContent;

    if (!isSafeWorkspacePath(filePath)) {
      return reply.code(400).send({ message: 'path is required and must be workspace-relative' });
    }
    if (typeof content !== 'string') {
      return reply.code(400).send({ message: 'content must be a string' });
    }
    if (expectedContent !== undefined && typeof expectedContent !== 'string') {
      return reply.code(400).send({ message: 'expectedContent must be a string when provided' });
    }

    try {
      const saved = await controller.saveFileToWorkspace({
        filePath,
        content,
        expectedContent,
      });
      return { filePath: saved.filePath, bytes: saved.bytes, updatedAt: saved.updatedAt };
    } catch (err) {
      return reply.code(workspaceErrorStatus(err)).send({
        code: workspaceErrorCode(err),
        message: err instanceof Error ? err.message : 'Workspace file save failed',
      });
    }
  });
};
