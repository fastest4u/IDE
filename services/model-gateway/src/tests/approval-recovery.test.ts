import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createModelGatewayServer } from '../server';

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-approval-recovery-'));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, 'workspace-'));
  const dataDir = await mkdtemp(path.join(tempRoot, 'data-'));

  try {
    await writeFile(path.join(workspaceRoot, 'package.json'), '{"name":"approval-recovery"}\n', 'utf8');

    const { app: firstApp } = await createModelGatewayServer({
      logger: false,
      workspaceRoot,
      dataDir,
      providerConfigs: [],
      workspacePicker: { pickDirectory: async () => workspaceRoot },
    });

    let approvalId = '';
    try {
      const created = await firstApp.inject({
        method: 'POST',
        url: '/terminal/exec',
        payload: { command: 'printf approval-recovery' },
      });
      assert.ok([201, 202].includes(created.statusCode));
      if (created.statusCode === 202) {
        const body = created.json() as { approval?: { id?: string } };
        approvalId = body.approval?.id ?? '';
        assert.ok(approvalId);
      }

      const pending = await firstApp.inject({ method: 'GET', url: '/tool-approvals?status=pending' });
      assert.equal(pending.statusCode, 200);
      const pendingBody = pending.json() as { approvals: Array<{ id: string }> };
      if (!approvalId && pendingBody.approvals[0]) {
        approvalId = pendingBody.approvals[0].id;
      }
      assert.ok(approvalId);

      const pendingFile = await readFile(path.join(dataDir, 'tool-approvals.json'), 'utf8');
      assert.ok(pendingFile.includes(approvalId));
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
      const hydrated = await secondApp.inject({ method: 'GET', url: '/tool-approvals?status=pending' });
      assert.equal(hydrated.statusCode, 200);
      const hydratedBody = hydrated.json() as { approvals: Array<{ id: string; status: string }> };
      assert.ok(hydratedBody.approvals.some((approval) => approval.id === approvalId && approval.status === 'pending'));

      const approve = await secondApp.inject({
        method: 'POST',
        url: `/tool-approvals/${approvalId}/approve`,
        payload: { reason: 'Recovered approval can proceed' },
      });
      assert.equal(approve.statusCode, 200);
      const approveBody = approve.json() as { approval: { status: string; reason?: string } };
      assert.equal(approveBody.approval.status, 'approved');
      assert.equal(approveBody.approval.reason, 'Recovered approval can proceed');

      const approvalNote = await readFile(path.join(workspaceRoot, 'docs/memory/database/tool-approvals', `${approvalId}.md`), 'utf8');
      assert.ok(approvalNote.includes('status: approved'));
      assert.ok(approvalNote.includes('Recovered approval can proceed'));
    } finally {
      await secondApp.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
