import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createModelGatewayServer } from '../server';
import { WorkflowStore } from '../workflows';

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-crash-recovery-'));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, 'workspace-'));
  const dataDir = await mkdtemp(path.join(tempRoot, 'data-'));

  try {
    await writeFile(path.join(workspaceRoot, 'package.json'), '{"name":"crash-recovery"}\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'safe.txt'), 'before\n', 'utf8');

    const workflowStore = new WorkflowStore({ workspaceRoot });
    workflowStore.save({
      id: 'crash-recovery-workflow',
      name: 'Crash Recovery Workflow',
      roles: ['planner', 'coder', 'synthesizer'],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          { id: 'planner', type: 'agent', label: 'Planner', role: 'planner', position: { x: 100, y: 0 } },
          { id: 'coder', type: 'agent', label: 'Coder', role: 'coder', position: { x: 200, y: 0 } },
          { id: 'synth', type: 'synthesizer', label: 'Synth', role: 'synthesizer', position: { x: 300, y: 0 } },
          { id: 'end', type: 'end', label: 'End', position: { x: 400, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'planner' },
          { id: 'e2', source: 'planner', target: 'coder' },
          { id: 'e3', source: 'coder', target: 'synth' },
          { id: 'e4', source: 'synth', target: 'end' },
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

    try {
      const createSession = await firstApp.inject({
        method: 'POST',
        url: '/ai/generate',
        payload: {
          id: 'crash-recovery-ai',
          kind: 'chat',
          prompt: 'Create persisted agent state',
          context: { workspaceId: 'workspace-recovery', sessionId: 'session-recovery' },
        },
      });
      assert.equal(createSession.statusCode, 200);

      const addDecision = await firstApp.inject({
        method: 'POST',
        url: '/sessions/session-recovery/decision',
        payload: { decision: 'Persist this decision' },
      });
      assert.equal(addDecision.statusCode, 200);

      const addConstraint = await firstApp.inject({
        method: 'POST',
        url: '/sessions/session-recovery/constraint',
        payload: { constraint: 'Keep writes local' },
      });
      assert.equal(addConstraint.statusCode, 200);

      const sessionBeforeRestart = await firstApp.inject({
        method: 'GET',
        url: '/sessions/session-recovery',
      });
      assert.equal(sessionBeforeRestart.statusCode, 200);
      const beforeBody = sessionBeforeRestart.json() as { state: { goal: string; decisions: string[]; constraints: string[] } | null };
      assert.equal(beforeBody.state?.goal, 'Create persisted agent state');
      assert.equal(beforeBody.state?.decisions?.[0], 'Persist this decision');
      assert.equal(beforeBody.state?.constraints?.[0], 'Keep writes local');
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
      const hydratedSession = await secondApp.inject({
        method: 'GET',
        url: '/sessions/session-recovery',
      });
      assert.equal(hydratedSession.statusCode, 200);
      const sessionBody = hydratedSession.json() as { state: { goal: string; decisions: string[]; constraints: string[] } | null };
      assert.equal(sessionBody.state?.goal, 'Create persisted agent state');
      assert.equal(sessionBody.state?.decisions?.[0], 'Persist this decision');
      assert.equal(sessionBody.state?.constraints?.[0], 'Keep writes local');

      const decisionResp = await secondApp.inject({
        method: 'POST',
        url: '/sessions/session-recovery/decision',
        payload: { decision: '  approve recovery path  ' },
      });
      assert.equal(decisionResp.statusCode, 200);
      const decisionBody = decisionResp.json() as { decision: string };
      assert.equal(decisionBody.decision, 'approve recovery path');

      const constraintResp = await secondApp.inject({
        method: 'POST',
        url: '/sessions/session-recovery/constraint',
        payload: { constraint: '  keep writes local  ' },
      });
      assert.equal(constraintResp.statusCode, 200);
      const constraintBody = constraintResp.json() as { constraint: string };
      assert.equal(constraintBody.constraint, 'keep writes local');

      const sessionNote = await readFile(path.join(workspaceRoot, 'docs/memory/database/sessions/session-recovery.md'), 'utf8');
      assert.ok(sessionNote.includes('approve recovery path'));
      assert.ok(sessionNote.includes('keep writes local'));

      const sessionsPath = path.join(dataDir, 'sessions.json');
      const sessionsJson = await readFile(sessionsPath, 'utf8');
      assert.ok(sessionsJson.includes('session-recovery'));
    } finally {
      await secondApp.close();
      await new Promise<void>((resolve) => mockProviderServer.close(() => resolve()));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
