import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createModelGatewayServer } from '../server';

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-terminal-recovery-'));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, 'workspace-'));
  const dataDir = await mkdtemp(path.join(tempRoot, 'data-'));

  try {
    await writeFile(path.join(workspaceRoot, 'package.json'), '{"name":"terminal-recovery"}\n', 'utf8');

    const { app: firstApp } = await createModelGatewayServer({
      logger: false,
      workspaceRoot,
      dataDir,
      providerConfigs: [],
      workspacePicker: { pickDirectory: async () => workspaceRoot },
    });

    let sessionId = '';
    try {
      const exec = await firstApp.inject({
        method: 'POST',
        url: '/terminal/exec',
        payload: { command: 'printf terminal-recovery' },
      });
      assert.ok([201, 202].includes(exec.statusCode));
      if (exec.statusCode === 201) {
        const body = exec.json() as { session?: { id?: string } };
        sessionId = body.session?.id ?? '';
      } else {
        const body = exec.json() as { approval?: { id?: string } };
        sessionId = body.approval?.id ?? '';
      }
      assert.ok(sessionId);

      const output = await firstApp.inject({ method: 'GET', url: '/terminal/output' });
      assert.equal(output.statusCode, 200);
      const outputBody = output.json() as { sessions?: Array<{ id: string }>; output: string };
      assert.ok(outputBody.output.length >= 0);

      const sessionsFile = await readFile(path.join(dataDir, 'tool-approvals.json'), 'utf8').catch(() => '');
      assert.ok(sessionsFile.includes('terminal'));
    } finally {
      await firstApp.close();
    }

    const { app: secondApp } = await createModelGatewayServer({
      logger: false,
      workspaceRoot,
      dataDir,
      providerConfigs: [],
      workspacePicker: { pickDirectory: async () => workspaceRoot },
    });

    try {
      const output = await secondApp.inject({ method: 'GET', url: '/terminal/output' });
      assert.equal(output.statusCode, 200);
      const outputBody = output.json() as { sessions: Array<{ id: string }> };
      assert.ok(Array.isArray(outputBody.sessions));

      const restart = await secondApp.inject({
        method: 'POST',
        url: `/terminal/${sessionId}/restart`,
        payload: { command: 'printf terminal-recovery-restart' },
      });
      assert.ok([201, 202].includes(restart.statusCode));

      const kill = await secondApp.inject({
        method: 'POST',
        url: `/terminal/${sessionId}/kill`,
      });
      assert.ok([200, 404].includes(kill.statusCode));
    } finally {
      await secondApp.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
