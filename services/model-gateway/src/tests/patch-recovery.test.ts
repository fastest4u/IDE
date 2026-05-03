import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createModelGatewayServer } from '../server';

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-patch-recovery-'));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, 'workspace-'));
  const dataDir = await mkdtemp(path.join(tempRoot, 'data-'));

  try {
    await writeFile(path.join(workspaceRoot, 'package.json'), '{"name":"patch-recovery"}\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'safe.txt'), 'before\n', 'utf8');

    const { app: firstApp } = await createModelGatewayServer({
      logger: false,
      workspaceRoot,
      dataDir,
      providerConfigs: [],
      workspacePicker: { pickDirectory: async () => workspaceRoot },
    });

    let patchId = '';
    try {
      const createPatch = await firstApp.inject({
        method: 'POST',
        url: '/patches',
        payload: {
          id: 'patch-recovery-safe',
          title: 'Patch recovery safe',
          summary: 'Update safe file after restart',
          operations: [
            {
              id: 'op-1',
              kind: 'write_file',
              filePath: 'safe.txt',
              beforeContent: 'before\n',
              afterContent: 'after\n',
            },
          ],
        },
      });
      assert.equal(createPatch.statusCode, 201);
      const createdBody = createPatch.json() as { patch: { id: string; status: string } };
      patchId = createdBody.patch.id;
      assert.equal(createdBody.patch.status, 'pending');

      const patchFile = await readFile(path.join(dataDir, 'patches.json'), 'utf8');
      assert.ok(patchFile.includes(patchId));
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
      const hydratedPatch = await secondApp.inject({
        method: 'GET',
        url: `/patches/${patchId}`,
      });
      assert.equal(hydratedPatch.statusCode, 200);
      const hydratedBody = hydratedPatch.json() as { patch: { id: string; status: string } };
      assert.equal(hydratedBody.patch.id, patchId);
      assert.equal(hydratedBody.patch.status, 'pending');

      const approve = await secondApp.inject({
        method: 'POST',
        url: `/patches/${patchId}/approve`,
      });
      assert.equal(approve.statusCode, 200);

      const apply = await secondApp.inject({
        method: 'POST',
        url: `/patches/${patchId}/apply`,
      });
      assert.equal(apply.statusCode, 200);
      assert.equal(await readFile(path.join(workspaceRoot, 'safe.txt'), 'utf8'), 'after\n');

      const rollback = await secondApp.inject({
        method: 'POST',
        url: `/patches/${patchId}/rollback`,
      });
      assert.equal(rollback.statusCode, 200);
      assert.equal(await readFile(path.join(workspaceRoot, 'safe.txt'), 'utf8'), 'before\n');

      const patchesJson = await readFile(path.join(dataDir, 'patches.json'), 'utf8');
      assert.ok(patchesJson.includes('rolled_back'));
      assert.ok(patchesJson.includes('Patch recovery safe'));
    } finally {
      await secondApp.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
