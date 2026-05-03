import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createModelGatewayServer } from '../server';
import { WorkflowStore } from '../workflows';

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-workflow-recovery-'));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, 'workspace-'));
  const dataDir = await mkdtemp(path.join(tempRoot, 'data-'));

  try {
    await writeFile(path.join(workspaceRoot, 'package.json'), '{"name":"workflow-recovery"}\n', 'utf8');

    const workflowStore = new WorkflowStore({ workspaceRoot });
    const workflow = workflowStore.save({
      id: 'workflow-approval-recovery',
      name: 'Workflow Approval Recovery',
      roles: ['planner', 'coder', 'synthesizer'],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          { id: 'planner', type: 'agent', label: 'Planner', role: 'planner', position: { x: 100, y: 0 } },
          { id: 'coder', type: 'agent', label: 'Coder', role: 'coder', position: { x: 200, y: 0 } },
          { id: 'approval', type: 'approval', label: 'Approval', position: { x: 300, y: 0 }, config: { requiredFor: ['patch', 'deploy'] } },
          { id: 'synth', type: 'synthesizer', label: 'Synth', role: 'synthesizer', position: { x: 400, y: 0 } },
          { id: 'end', type: 'end', label: 'End', position: { x: 500, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'planner' },
          { id: 'e2', source: 'planner', target: 'coder' },
          { id: 'e3', source: 'coder', target: 'approval' },
          { id: 'e4', source: 'approval', target: 'synth' },
          { id: 'e5', source: 'synth', target: 'end' },
        ],
      },
    });

    const mockProviderServer = createServer((request: IncomingMessage, reply: ServerResponse) => {
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
        return;
      }
      reply.writeHead(404, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve, reject) => {
      mockProviderServer.once('error', reject);
      mockProviderServer.listen(0, '127.0.0.1', () => {
        mockProviderServer.off('error', reject);
        resolve();
      });
    });
    const mockAddress = mockProviderServer.address();
    if (!mockAddress || typeof mockAddress === 'string') {
      throw new Error('mock provider failed to bind');
    }
    const mockBaseUrl = `http://127.0.0.1:${mockAddress.port}`;

    const { app: firstApp } = await createModelGatewayServer({
      logger: false,
      workspaceRoot,
      dataDir,
      providerConfigs: [{
        providerId: 'custom',
        baseUrl: mockBaseUrl,
        models: [{ modelId: 'local-model', displayName: 'Local Model', tier: 'local', capabilities: { tools: false, vision: false, reasoning: false, streaming: false, longContext: false, codeEditing: false, embeddings: false, reranking: false }, maxContextTokens: 4096 }],
      }],
      workspacePicker: { pickDirectory: async () => workspaceRoot },
    });

    let runId = '';
    try {
      const collaboration = await firstApp.inject({
        method: 'POST',
        url: '/ai/collaborate',
        payload: {
          id: 'workflow-recovery-collab',
          goal: 'Pause for approval',
          kind: 'refactor',
          workflowId: workflow.id,
          context: { workspaceId: 'workspace-recovery', sessionId: 'session-workflow-recovery' },
        },
      });
      assert.equal(collaboration.statusCode, 200);
      const body = collaboration.json() as { runState?: { runId: string; status: string; pausedAtNodeId?: string } };
      runId = body.runState?.runId ?? '';
      assert.ok(runId);
      assert.equal(body.runState?.status, 'paused_approval');
      assert.equal(body.runState?.pausedAtNodeId, 'approval');

      const runNote = await firstApp.inject({
        method: 'GET',
        url: `/workflows/runs/${runId}`,
      });
      assert.equal(runNote.statusCode, 200);
    } finally {
      await firstApp.close();
      await new Promise<void>((resolve) => mockProviderServer.close(() => resolve()));
    }

    const { app: secondApp } = await createModelGatewayServer({
      logger: false,
      workspaceRoot,
      dataDir,
      providerConfigs: [],
      workspacePicker: { pickDirectory: async () => workspaceRoot },
    });

    try {
      const hydratedRun = await secondApp.inject({
        method: 'GET',
        url: `/workflows/runs/${runId}`,
      });
      assert.equal(hydratedRun.statusCode, 200);
      const hydratedBody = hydratedRun.json() as { run: { status: string; pausedAtNodeId?: string } };
      assert.equal(hydratedBody.run.status, 'paused_approval');
      assert.equal(hydratedBody.run.pausedAtNodeId, 'approval');

      const approveMissingNode = await secondApp.inject({
        method: 'POST',
        url: `/workflows/runs/${runId}/approve`,
        payload: { reason: 'continue' },
      });
      assert.equal(approveMissingNode.statusCode, 400);

      const approveWithNode = await secondApp.inject({
        method: 'POST',
        url: `/workflows/runs/${runId}/approve`,
        payload: { nodeId: 'approval', reason: 'Approved after restart' },
      });
      assert.equal(approveWithNode.statusCode, 200);

      const workflowRunAfterApprove = await secondApp.inject({
        method: 'GET',
        url: `/workflows/runs/${runId}`,
      });
      assert.equal(workflowRunAfterApprove.statusCode, 200);
      const afterBody = workflowRunAfterApprove.json() as { run: { status: string; pausedAtNodeId?: string } };
      assert.notEqual(afterBody.run.status, 'paused_approval');
      assert.equal(afterBody.run.pausedAtNodeId, undefined);
    } finally {
      await secondApp.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
