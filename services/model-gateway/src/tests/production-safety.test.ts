import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createModelGatewayServer } from '../server';
import { WorkflowStore } from '../workflows';
import { AgentRunService } from '../agent-run';
import { WorkspaceContextService } from '../memory/workspace-context';
import { ObsidianDatabaseService } from '../obsidian-database';
import { TerminalSessionService } from '../terminal/terminal-session';

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-prod-safety-'));
  const workspaceRoot = await mkdtemp(path.join(tempRoot, 'workspace-'));
  const dataDir = await mkdtemp(path.join(tempRoot, 'data-'));

  try {
    await writeFile(path.join(workspaceRoot, 'package.json'), '{"name":"prod-safety"}\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'README.md'), '# Safety\n', 'utf8');

    const workflowStore = new WorkflowStore({ workspaceRoot });
    assert.throws(() => workflowStore.save({
      id: 'invalid-cycle',
      name: 'Invalid Cycle',
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
          { id: 'e4', source: 'synth', target: 'coder' },
          { id: 'e5', source: 'synth', target: 'end' },
        ],
      },
    }), /cycle/i, 'workflow graph cycle should be rejected');

    assert.throws(() => workflowStore.save({
      id: 'invalid-unreachable',
      name: 'Invalid Unreachable',
      roles: ['planner', 'coder', 'synthesizer'],
      graph: {
        version: 1,
        nodes: [
          { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
          { id: 'planner', type: 'agent', label: 'Planner', role: 'planner', position: { x: 100, y: 0 } },
          { id: 'coder', type: 'agent', label: 'Coder', role: 'coder', position: { x: 200, y: 0 } },
          { id: 'synth', type: 'synthesizer', label: 'Synth', role: 'synthesizer', position: { x: 300, y: 0 } },
          { id: 'orphan', type: 'agent', label: 'Orphan', role: 'reviewer', position: { x: 400, y: 0 } },
          { id: 'end', type: 'end', label: 'End', position: { x: 500, y: 0 } },
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'planner' },
          { id: 'e2', source: 'planner', target: 'coder' },
          { id: 'e3', source: 'coder', target: 'synth' },
          { id: 'e4', source: 'synth', target: 'end' },
        ],
      },
    }), /unreachable/i, 'workflow graph unreachable node should be rejected');

    const readyWorkflow = workflowStore.save({
      id: 'valid-production-workflow',
      name: 'Valid Production Workflow',
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
    assert.equal(readyWorkflow.id, 'valid-production-workflow');
    assert.equal(readyWorkflow.currentVersion, 1);

    const workspaceService = new WorkspaceContextService();
    await workspaceService.setWorkspaceRoot(workspaceRoot);
    await workspaceService.writeFileContent({ filePath: 'safe.txt', content: 'hello\n' });
    assert.equal(await workspaceService.readFileContentStrict('safe.txt'), 'hello\n');
    await assert.rejects(() => workspaceService.writeFileContent({ filePath: '../escape.txt', content: 'nope\n' }), /workspace/i, 'workspace traversal should be rejected');

    const obsidianDb = new ObsidianDatabaseService({ workspaceRoot, enabled: true });
    obsidianDb.setWorkspaceRoot(workspaceRoot);
    const approvalPath = await obsidianDb.writeToolApproval({
      id: 'approval-1',
      tool: 'terminal',
      action: 'terminal.exec',
      status: 'pending',
      summary: 'Check approval persistence',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    assert.ok(approvalPath?.includes('tool-approvals'));

    const terminalService = new TerminalSessionService(workspaceRoot);
    const session = terminalService.createSession('printf safety-test');
    assert.ok(session.getInfo().id);
    session.kill();

    const agentRunService = new AgentRunService({ controller: {
      retrieveObsidianRag: () => [],
      searchWorkspaceFiles: async () => [],
      readFileFromWorkspace: async () => 'content',
      getPatchService: () => undefined,
    } as never });
    await assert.rejects(() => agentRunService.create({ sessionId: ' ', goal: 'x' }), /sessionId/i);
    await assert.rejects(() => agentRunService.create({ sessionId: 'session-1', goal: ' ' }), /goal/i);
    const run = await agentRunService.create({ sessionId: 'session-1', goal: 'Run valid' });
    assert.equal(run.status, 'queued');

    const server = await createModelGatewayServer({
      logger: false,
      workspaceRoot,
      dataDir,
      providerConfigs: [],
      workspacePicker: { pickDirectory: async () => workspaceRoot },
    });
    try {
      const agentsResponse = await server.app.inject({
        method: 'POST',
        url: '/agents/runs',
        payload: { sessionId: ' ', goal: '   ' },
      });
      assert.equal(agentsResponse.statusCode, 400);

      const terminalResponse = await server.app.inject({
        method: 'POST',
        url: '/terminal/exec',
        payload: { command: 'printf production-test' },
      });
      assert.ok([201, 202].includes(terminalResponse.statusCode));

      const sessionsFilePath = path.join(dataDir, 'sessions.json');
      const persisted = await readFile(sessionsFilePath, 'utf8').catch(() => '');
      assert.ok(persisted.length === 0 || persisted.includes('session-1'), 'session persistence should be safe to hydrate');
    } finally {
      await server.app.close();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main();
