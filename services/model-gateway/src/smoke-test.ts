import { AI_PATCH_TOOL_SPEC, type AIRequest } from '@ide/protocol';
import { createStableCacheKey, StableMemoryCache } from './index';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createModelGatewayServer } from './server';
import type { ProviderConnectionConfig } from './config/provider-config';

function assertStatus(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected}, received ${actual}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(reply: ServerResponse, statusCode: number, body: unknown): void {
  reply.writeHead(statusCode, { 'content-type': 'application/json' });
  reply.end(JSON.stringify(body));
}

let lastProviderPrompt = '';

const mockOpenAIServer = createServer(async (request, reply) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(reply, 200, { data: [{ id: 'local-model' }, { id: 'gpt-4o' }] });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = JSON.parse(await readRequestBody(request) || '{}') as {
      model?: string;
      stream?: boolean;
      tools?: unknown[];
      messages?: Array<{ role?: string; content?: string }>;
    };
    lastProviderPrompt = body.messages?.map((message) => message.content ?? '').join('\n') ?? '';
    if (body.stream) {
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      if (JSON.stringify(body.tools ?? []).includes(AI_PATCH_TOOL_SPEC.name)) {
        const toolArguments = JSON.stringify({
          title: 'AI patch smoke',
          summary: 'Replace safe.txt content from streamed tool call',
          operations: [
            {
              id: 'op-ai-safe',
              kind: 'write_file',
              filePath: 'safe.txt',
              beforeContent: 'before\n',
              afterContent: 'after from ai patch\n',
            },
          ],
        });
        reply.write(`data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'smoke-ai-patch-stream:patch',
                    type: 'function',
                    function: {
                      name: AI_PATCH_TOOL_SPEC.name,
                      arguments: toolArguments,
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`);
      } else {
        reply.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stream smoke response' } }] })}\n\n`);
      }
      reply.write('data: [DONE]\n\n');
      reply.end();
      return;
    }

    sendJson(reply, 200, {
      choices: [
        {
          message: {
            content: `mock response from ${body.model ?? 'model'}`,
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
      },
    });
    return;
  }

  sendJson(reply, 404, { error: 'not found' });
});

await new Promise<void>((resolve, reject) => {
  mockOpenAIServer.once('error', reject);
  mockOpenAIServer.listen(0, '127.0.0.1', () => {
    mockOpenAIServer.off('error', reject);
    resolve();
  });
});
const mockAddress = mockOpenAIServer.address();
if (!mockAddress || typeof mockAddress === 'string') {
  throw new Error('Mock provider failed to bind to a local port');
}
const mockBaseUrl = `http://127.0.0.1:${(mockAddress as AddressInfo).port}`;

const testProviders: ProviderConnectionConfig[] = [
  {
    providerId: 'openai',
    baseUrl: mockBaseUrl,
    apiKey: 'test-api-key',
    models: [
      {
        modelId: 'gpt-4o',
        displayName: 'GPT-4o',
        tier: 'premium',
        capabilities: {
          tools: true, vision: true, reasoning: true, streaming: true,
          longContext: true, codeEditing: true, embeddings: true, reranking: false,
        },
        maxContextTokens: 128000,
      },
    ],
  },
  {
    providerId: 'custom',
    baseUrl: mockBaseUrl,
    models: [
      {
        modelId: 'local-model',
        displayName: 'Local Model',
        tier: 'local',
        capabilities: {
          tools: false, vision: false, reasoning: false, streaming: true,
          longContext: true, codeEditing: true, embeddings: false, reranking: false,
        },
        maxContextTokens: 8096,
      },
    ],
  },
];

const tempDataRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-local-data-smoke-'));
const tempPatchRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-patch-smoke-'));
await writeFile(path.join(tempPatchRoot, 'package.json'), '{"name":"smoke-workspace"}\n', 'utf8');
await writeFile(
  path.join(tempPatchRoot, 'rag-note.md'),
  [
    '---',
    'title: RAG Smoke Knowledge',
    'tags:',
    '  - ai/rag',
    '---',
    '',
    '# RAG Smoke Knowledge',
    '',
    'The retrieval answer is obsidian-rag-sentinel. Use this sentence to validate chunk retrieval citations.',
    '',
  ].join('\n'),
  'utf8',
);
const { app, controller } = await createModelGatewayServer({
  logger: false,
  providerConfigs: testProviders,
  workspaceRoot: tempPatchRoot,
  dataDir: tempDataRoot,
  workspacePicker: {
    pickDirectory: async () => tempPatchRoot,
  },
});

try {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assertStatus(health.statusCode, 200, 'GET /health');

  const settings = await app.inject({ method: 'GET', url: '/settings' });
  assertStatus(settings.statusCode, 200, 'GET /settings');

  const settingsBody = settings.json() as {
    settings: {
      memory: { dataDir: string; persistSessionMemory: boolean };
      localProviders: Array<{ providerId: 'opencode-go' | 'custom'; enabled: boolean; baseUrl: string; models: string[]; timeoutMs: number }>;
    };
  };
  assert(settingsBody.settings.memory.dataDir === tempDataRoot, 'settings should use local data dir');
  assert(settingsBody.settings.localProviders.some((provider) => provider.providerId === 'opencode-go'), 'settings should include OpenCode Go');

  const readonlySettings = await app.inject({
    method: 'GET',
    url: '/settings',
    headers: { 'x-ide-capability-profile': 'readonly' },
  });
  assertStatus(readonlySettings.statusCode, 200, 'GET /settings readonly capability');

  const readonlySettingsUpdate = await app.inject({
    method: 'PATCH',
    url: '/settings',
    headers: { 'x-ide-capability-profile': 'readonly', 'x-ide-actor-id': 'readonly-smoke' },
    payload: { desktop: { reuseWebShell: true } },
  });
  assertStatus(readonlySettingsUpdate.statusCode, 403, 'PATCH /settings denied for readonly capability');
  const readonlySettingsUpdateBody = readonlySettingsUpdate.json() as { code: string; capability?: string; actor?: string };
  assert(readonlySettingsUpdateBody.code === 'CAPABILITY_DENIED', 'readonly settings update should be denied by capability policy');
  assert(readonlySettingsUpdateBody.capability === 'settings.update', 'readonly settings update should identify settings.update capability');

  const agentTerminal = await app.inject({
    method: 'POST',
    url: '/terminal/exec',
    headers: { 'x-ide-capability-profile': 'agent-runtime', 'x-ide-actor-id': 'agent-smoke' },
    payload: { command: 'echo denied' },
  });
  assertStatus(agentTerminal.statusCode, 403, 'POST /terminal/exec denied for agent-runtime capability');
  const agentTerminalBody = agentTerminal.json() as { code: string; capability?: string; actor?: string };
  assert(agentTerminalBody.code === 'CAPABILITY_DENIED', 'agent terminal exec should be denied by capability policy');
  assert(agentTerminalBody.capability === 'terminal.execute', 'agent terminal denial should identify terminal.execute capability');
  assert(agentTerminalBody.actor === 'agent-smoke', 'capability denial should preserve actor id');

  const auditLogAfterCapabilityDenial = await readFile(path.join(tempDataRoot, 'audit-log.json'), 'utf8');
  assert(auditLogAfterCapabilityDenial.includes('capability.denied'), 'capability denial should be audited');
  assert(auditLogAfterCapabilityDenial.includes('agent-smoke'), 'capability denial audit should include actor id');

  const enableCustomSettings = await app.inject({
    method: 'PATCH',
    url: '/settings',
    payload: {
      localProviders: [
        ...settingsBody.settings.localProviders.filter((provider) => provider.providerId !== 'custom'),
        {
          providerId: 'custom',
          enabled: true,
          baseUrl: mockBaseUrl,
          models: ['local-model'],
          timeoutMs: 60000,
        },
      ],
    },
  });
  assertStatus(enableCustomSettings.statusCode, 200, 'PATCH /settings hot-reloads custom provider');

  const providerStatus = await app.inject({ method: 'GET', url: '/settings/provider-status' });
  assertStatus(providerStatus.statusCode, 200, 'GET /settings/provider-status');
  const providerStatusBody = providerStatus.json() as {
    localOnlyReady: boolean;
    providers: Array<{ providerId: string; registered: boolean; healthy: boolean; modelIds: string[] }>;
  };
  assert(providerStatusBody.providers.some((provider) => provider.providerId === 'custom' && provider.registered), 'enabled custom provider should be registered without restart');
  assert(providerStatusBody.providers.some((provider) => provider.providerId === 'custom' && provider.modelIds.includes('local-model')), 'static custom provider should stay registered after reload');

  const testCustom = await app.inject({ method: 'POST', url: '/settings/providers/custom/test' });
  assertStatus(testCustom.statusCode, 200, 'POST /settings/providers/:providerId/test');
  const testCustomBody = testCustom.json() as { ok: boolean; provider: { providerId: string } };
  assert(testCustomBody.ok && testCustomBody.provider.providerId === 'custom', 'custom test connection should use runtime adapter');

  const workspaceOverrideSettings = await app.inject({
    method: 'PATCH',
    url: '/settings',
    payload: {
      workspaceOverrides: {
        'workspace-alt': {
          workspaceId: 'workspace-alt',
          policy: { defaultStrategy: 'latencyOptimized' },
          localProviderIds: ['custom'],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  });
  assertStatus(workspaceOverrideSettings.statusCode, 200, 'PATCH /settings workspace override');
  const workspaceOverrideBody = workspaceOverrideSettings.json() as { settings: { workspaceOverrides: Record<string, unknown> } };
  assert(!!workspaceOverrideBody.settings.workspaceOverrides['workspace-alt'], 'workspace override should persist');

  const localOnlySettings = await app.inject({
    method: 'PATCH',
    url: '/settings',
    payload: {
      policy: {
        privacyMode: 'localOnly',
        allowCloudProviders: false,
        defaultStrategy: 'localOnly',
      },
    },
  });
  assertStatus(localOnlySettings.statusCode, 200, 'PATCH /settings localOnly');

  const blockedDataRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-no-local-smoke-'));
  const { app: blockedApp } = await createModelGatewayServer({
    logger: false,
    providerConfigs: [],
    dataDir: blockedDataRoot,
  });
  try {
    const blockedSettings = await blockedApp.inject({ method: 'GET', url: '/settings' });
    assertStatus(blockedSettings.statusCode, 200, 'GET /settings for localOnly block test');
    const blockedSettingsBody = blockedSettings.json() as {
      settings: { localProviders: Array<{ providerId: 'opencode-go' | 'custom'; enabled: boolean; baseUrl: string; models: string[]; timeoutMs: number }> };
    };

    const blockedLocalOnly = await blockedApp.inject({
      method: 'PATCH',
      url: '/settings',
      payload: {
        policy: {
          privacyMode: 'localOnly',
          allowCloudProviders: false,
          defaultStrategy: 'localOnly',
        },
        localProviders: blockedSettingsBody.settings.localProviders.map((provider) => ({
          ...provider,
          enabled: false,
        })),
      },
    });
    assertStatus(blockedLocalOnly.statusCode, 409, 'PATCH /settings blocks localOnly without reachable local model');
  } finally {
    await blockedApp.close();
    await rm(blockedDataRoot, { recursive: true, force: true });
  }

  const sessionId = 'session-memory-test';
  const request: AIRequest = {
    id: 'smoke-generate',
    kind: 'chat',
    prompt: 'Test memory context builder',
    context: { workspaceId: 'workspace-smoke', sessionId },
  };

  const generate = await app.inject({
    method: 'POST',
    url: '/ai/generate',
    payload: request,
  });
  assertStatus(generate.statusCode, 200, 'POST /ai/generate');

  const generateBody = generate.json() as {
    requestId?: string;
    providerId?: string;
    metadata?: { sessionId?: string; taskGoal?: string; handoffSummary?: string };
  };
  assert(generateBody.requestId === request.id, 'wrong requestId');
  assert(
    generateBody.providerId === 'custom',
    'privacy mode should force a local provider',
  );
  assert(generateBody.metadata?.sessionId === sessionId, 'missing sessionId in metadata');

  const obsidianStats = await app.inject({ method: 'GET', url: '/memory/obsidian/stats' });
  assertStatus(obsidianStats.statusCode, 200, 'GET /memory/obsidian/stats');
  const obsidianStatsBody = obsidianStats.json() as { obsidian: { total: number; chunks?: number } };
  assert(obsidianStatsBody.obsidian.total > 0, 'Obsidian stats should include indexed notes');
  assert((obsidianStatsBody.obsidian.chunks ?? 0) > 0, 'Obsidian stats should include RAG chunks');

  const ragRetrieval = await app.inject({
    method: 'POST',
    url: '/memory/obsidian/rag',
    payload: { query: 'obsidian-rag-sentinel', limit: 3 },
  });
  assertStatus(ragRetrieval.statusCode, 200, 'POST /memory/obsidian/rag');
  const ragRetrievalBody = ragRetrieval.json() as {
    results: Array<{ chunk: { notePath: string; content: string }; citation: { path: string; lines: [number, number] }; score: number }>;
  };
  assert(
    ragRetrievalBody.results.some((result) => result.chunk.notePath === 'rag-note.md' && result.chunk.content.includes('obsidian-rag-sentinel')),
    'Obsidian RAG retrieval should return matching chunk',
  );
  assert(
    ragRetrievalBody.results.some((result) => result.citation.path === 'rag-note.md' && result.citation.lines[0] > 0),
    'Obsidian RAG retrieval should include citations',
  );

  lastProviderPrompt = '';
  const ragGenerate = await app.inject({
    method: 'POST',
    url: '/ai/generate',
    payload: {
      ...request,
      id: 'smoke-rag-generate',
      prompt: 'Use Obsidian RAG to find obsidian-rag-sentinel',
    },
  });
  assertStatus(ragGenerate.statusCode, 200, 'POST /ai/generate with Obsidian RAG');
  assert(lastProviderPrompt.includes('<knowledge-base source="obsidian-rag"'), 'provider prompt should include Obsidian RAG context');
  assert(lastProviderPrompt.includes('obsidian-rag-sentinel'), 'provider prompt should include retrieved Obsidian chunk content');
  assert(lastProviderPrompt.includes('path="rag-note.md"'), 'provider prompt should include Obsidian chunk citation path');

  const session = await app.inject({
    method: 'GET',
    url: `/sessions/${sessionId}`,
  });
  assertStatus(session.statusCode, 200, 'GET /sessions/:sessionId');

  const sessionBody = session.json() as { sessionId: string; state: { goal: string } | null };
  assert(!!sessionBody.state, 'session state should exist');
  if (!sessionBody.state) throw new Error('unreachable: session state null after assert');
  assert(sessionBody.state.goal === request.prompt, 'session goal should match prompt');

  const decisionResp = await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/decision`,
    payload: { decision: 'Use TypeScript strict mode' },
  });
  assertStatus(decisionResp.statusCode, 200, 'POST /sessions/:sessionId/decision');

  const constraintResp = await app.inject({
    method: 'POST',
    url: `/sessions/${sessionId}/constraint`,
    payload: { constraint: 'Must pass tsc --noEmit' },
  });
  assertStatus(constraintResp.statusCode, 200, 'POST /sessions/:sessionId/constraint');

  const sessionAfter = await app.inject({
    method: 'GET',
    url: `/sessions/${sessionId}`,
  });
  assertStatus(sessionAfter.statusCode, 200, 'GET /sessions/:sessionId after updates');

  const sessionAfterBody = sessionAfter.json() as {
    sessionId: string;
    state: { decisions: string[]; constraints: string[] } | null;
  };
  assert(sessionAfterBody.state?.decisions?.length === 1, 'decisions should have 1 entry');
  assert(sessionAfterBody.state?.decisions?.[0] === 'Use TypeScript strict mode', 'wrong decision');
  assert(sessionAfterBody.state?.constraints?.length === 1, 'constraints should have 1 entry');
  const obsidianSessionNote = await readFile(
    path.join(tempPatchRoot, 'docs/memory/database/sessions/session-memory-test.md'),
    'utf8',
  );
  assert(obsidianSessionNote.includes('type: agent-session'), 'Obsidian session note should include agent-session type');
  assert(obsidianSessionNote.includes('aliases:'), 'Obsidian session note should include aliases property');
  assert(obsidianSessionNote.includes('> [!note] Goal'), 'Obsidian session note should include a goal callout');
  assert(obsidianSessionNote.includes('Use TypeScript strict mode'), 'Obsidian session note should mirror decisions');

  const workspaceIndex = await app.inject({
    method: 'POST',
    url: '/workspace/index',
    payload: { rootDir: tempPatchRoot },
  });
  assertStatus(workspaceIndex.statusCode, 200, 'POST /workspace/index');

  const workspacePick = await app.inject({
    method: 'POST',
    url: '/workspace/pick',
  });
  assertStatus(workspacePick.statusCode, 200, 'POST /workspace/pick');
  const workspacePickBody = workspacePick.json() as { rootDir: string };
  assert(workspacePickBody.rootDir === tempPatchRoot, 'workspace picker should return injected root');

  const workspaceBody = workspaceIndex.json() as { fileCount: number; summary: string };
  assert(workspaceBody.fileCount > 0, 'workspace should index files');
  console.log(`Workspace indexed: ${workspaceBody.fileCount} files`);

  const wsSummary = await app.inject({ method: 'GET', url: '/workspace/summary' });
  assertStatus(wsSummary.statusCode, 200, 'GET /workspace/summary');

  const wsFiles = await app.inject({ method: 'GET', url: '/workspace/files' });
  assertStatus(wsFiles.statusCode, 200, 'GET /workspace/files');

  const wsSearch = await app.inject({
    method: 'POST',
    url: '/workspace/search',
    payload: { query: 'export' },
  });
  assertStatus(wsSearch.statusCode, 200, 'POST /workspace/search');

  const generateWithContext = await app.inject({
    method: 'POST',
    url: '/ai/generate',
    payload: {
      ...request,
      id: 'smoke-workspace',
      context: { ...request.context, activeFilePath: 'package.json' },
    },
  });
  assertStatus(generateWithContext.statusCode, 200, 'POST /ai/generate with workspace');

  const collaborate = await app.inject({
    method: 'POST',
    url: '/ai/collaborate',
    payload: {
      id: 'collab-smoke',
      goal: 'Plan a safe refactor for the active workspace',
      kind: 'refactor',
      context: { workspaceId: 'workspace-smoke', sessionId },
      roles: ['planner', 'coder', 'reviewer'],
      strategy: 'committee',
      maxTokensPerRole: 256,
    },
  });
  assertStatus(collaborate.statusCode, 200, 'POST /ai/collaborate');

  const collaborateBody = collaborate.json() as {
    finalOutput?: { role?: string; status?: string };
    rolePlan?: Array<{ role: string }>;
    outputs?: Array<{ role: string; status: string; providerId?: string }>;
  };
  assert(collaborateBody.finalOutput?.role === 'synthesizer', 'collaboration final output should be synthesizer');
  assert(collaborateBody.rolePlan?.some((role) => role.role === 'synthesizer') === true, 'role plan should include synthesizer');
  assert(collaborateBody.outputs?.some((output) => output.role === 'planner' && output.status === 'completed') === true, 'planner should complete');

  const approvalWorkflow = await app.inject({
    method: 'POST',
    url: '/workflows',
    payload: {
      id: 'approval-smoke-workflow',
      name: 'Approval Smoke Workflow',
      roles: ['planner'],
      graph: {
        version: 1,
        nodes: [
          {
            id: 'node-planner',
            type: 'agent',
            label: 'Planner',
            role: 'planner',
            position: { x: 0, y: 0 },
          },
          {
            id: 'node-human-approval',
            type: 'approval',
            label: 'Human Approval',
            position: { x: 180, y: 0 },
            config: { requiredFor: ['smoke'] },
          },
        ],
        edges: [
          { id: 'edge-planner-approval', source: 'node-planner', target: 'node-human-approval' },
        ],
      },
    },
  });
  assertStatus(approvalWorkflow.statusCode, 201, 'POST /workflows approval smoke');

  const approvalCollaborate = await app.inject({
    method: 'POST',
    url: '/ai/collaborate',
    payload: {
      id: 'collab-approval-smoke',
      goal: 'Pause at human approval for persistence smoke test',
      kind: 'refactor',
      workflowId: 'approval-smoke-workflow',
      context: { workspaceId: 'workspace-smoke', sessionId },
      maxTokensPerRole: 128,
    },
  });
  assertStatus(approvalCollaborate.statusCode, 200, 'POST /ai/collaborate approval workflow');
  const approvalCollaborateBody = approvalCollaborate.json() as {
    runState?: { runId: string; status: string; pausedAtNodeId?: string };
    metadata?: { runId?: string; runStatus?: string };
  };
  assert(approvalCollaborateBody.runState?.status === 'paused_approval', 'approval workflow should pause');
  assert(approvalCollaborateBody.runState?.pausedAtNodeId === 'node-human-approval', 'approval workflow should pause at approval node');
  const workflowRunId = approvalCollaborateBody.runState?.runId;
  assert(!!workflowRunId, 'approval workflow should include run id');
  if (!workflowRunId) throw new Error('unreachable: workflowRunId missing after assert');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const workflowRunNote = await readFile(
    path.join(tempPatchRoot, `docs/memory/database/workflow-runs/${workflowRunId}.md`),
    'utf8',
  );
  assert(workflowRunNote.includes('type: workflow-run'), 'Obsidian workflow run note should include workflow-run type');
  assert(workflowRunNote.includes('status: paused_approval'), 'Obsidian workflow run note should mirror paused status');
  assert(workflowRunNote.includes('> [!info] Workflow Run Summary'), 'Obsidian workflow run note should include summary callout');

  const traceNote = await readFile(
    path.join(tempPatchRoot, 'docs/memory/database/traces/session-memory-test.md'),
    'utf8',
  );
  assert(traceNote.includes('type: session-trace'), 'Obsidian trace note should include session-trace type');
  assert(traceNote.includes('> [!info] Trace Summary'), 'Obsidian trace note should include trace summary callout');

  const workflowRecords = await app.inject({
    method: 'GET',
    url: '/memory/obsidian/database?type=workflow-run&status=paused_approval',
  });
  assertStatus(workflowRecords.statusCode, 200, 'GET /memory/obsidian/database workflow runs');
  const workflowRecordsBody = workflowRecords.json() as { records: Array<{ properties: { runId?: string } }> };
  assert(
    workflowRecordsBody.records.some((record) => record.properties.runId === workflowRunId),
    'Obsidian database query should include paused workflow run',
  );

  const stream = await app.inject({
    method: 'POST',
    url: '/ai/stream',
    payload: { ...request, id: 'smoke-stream', stream: true },
  });
  assertStatus(stream.statusCode, 200, 'POST /ai/stream');
  assert(stream.body.includes('data:'), 'stream missing SSE data');

  const patches = await app.inject({ method: 'GET', url: '/patches' });
  assertStatus(patches.statusCode, 200, 'GET /patches');

  await writeFile(path.join(tempPatchRoot, 'safe.txt'), 'before\n', 'utf8');
  await writeFile(path.join(tempPatchRoot, 'editable.ts'), 'export const value = 1;\n', 'utf8');
  const patchWorkspace = await app.inject({
    method: 'POST',
    url: '/workspace/index',
    payload: { rootDir: tempPatchRoot },
  });
  assertStatus(patchWorkspace.statusCode, 200, 'POST /workspace/index for patch root');

  const editableFiles = await app.inject({ method: 'GET', url: '/workspace/files' });
  assertStatus(editableFiles.statusCode, 200, 'GET /workspace/files for editable root');
  const editableFilesBody = editableFiles.json() as { files: string[] };
  assert(editableFilesBody.files.includes('editable.ts'), 'workspace files should include editable.ts');

  const editableBefore = await app.inject({
    method: 'GET',
    url: '/workspace/file?path=editable.ts',
  });
  assertStatus(editableBefore.statusCode, 200, 'GET /workspace/file editable.ts before save');
  const editableBeforeBody = editableBefore.json() as { content: string };
  assert(editableBeforeBody.content === 'export const value = 1;\n', 'editable.ts should load original content');

  const saveEditable = await app.inject({
    method: 'PUT',
    url: '/workspace/file',
    payload: {
      path: 'editable.ts',
      content: 'export const value = 2;\n',
      expectedContent: editableBeforeBody.content,
    },
  });
  assertStatus(saveEditable.statusCode, 200, 'PUT /workspace/file editable.ts');
  assert((await readFile(path.join(tempPatchRoot, 'editable.ts'), 'utf8')) === 'export const value = 2;\n', 'workspace save should write content');

  const editableAfter = await app.inject({
    method: 'GET',
    url: '/workspace/file?path=editable.ts',
  });
  assertStatus(editableAfter.statusCode, 200, 'GET /workspace/file editable.ts after save');
  const editableAfterBody = editableAfter.json() as { content: string };
  assert(editableAfterBody.content === 'export const value = 2;\n', 'workspace read should return saved content');

  const staleSave = await app.inject({
    method: 'PUT',
    url: '/workspace/file',
    payload: {
      path: 'editable.ts',
      content: 'export const value = 3;\n',
      expectedContent: editableBeforeBody.content,
    },
  });
  assertStatus(staleSave.statusCode, 409, 'PUT /workspace/file stale expectedContent');

  const terminalRequiresApproval = await app.inject({
    method: 'POST',
    url: '/terminal/exec',
    payload: { command: 'printf terminal-policy-smoke; sleep 0.5' },
  });
  assertStatus(terminalRequiresApproval.statusCode, 202, 'POST /terminal/exec queues approval by default');
  const terminalRequiresApprovalBody = terminalRequiresApproval.json() as {
    approval: { id: string; status: string; action: string; command?: string };
  };
  assert(terminalRequiresApprovalBody.approval.status === 'pending', 'terminal approval should be pending');
  assert(terminalRequiresApprovalBody.approval.action === 'terminal.exec', 'terminal approval should record action');
  assert(terminalRequiresApprovalBody.approval.command === 'printf terminal-policy-smoke; sleep 0.5', 'terminal approval should record command');

  const pendingApprovals = await app.inject({ method: 'GET', url: '/tool-approvals?status=pending' });
  assertStatus(pendingApprovals.statusCode, 200, 'GET /tool-approvals pending');
  const pendingApprovalsBody = pendingApprovals.json() as { approvals: Array<{ id: string; status: string }> };
  assert(
    pendingApprovalsBody.approvals.some((approval) => approval.id === terminalRequiresApprovalBody.approval.id),
    'pending approval list should include terminal command',
  );

  const approveTerminal = await app.inject({
    method: 'POST',
    url: `/tool-approvals/${terminalRequiresApprovalBody.approval.id}/approve`,
    payload: { reason: 'Smoke test approval' },
  });
  assertStatus(approveTerminal.statusCode, 200, 'POST /tool-approvals/:approvalId/approve');
  const approveTerminalBody = approveTerminal.json() as {
    approval: { status: string; result?: { sessionId?: string } };
  };
  assert(approveTerminalBody.approval.status === 'approved', 'approved terminal approval should be approved');
  assert(!!approveTerminalBody.approval.result?.sessionId, 'approved terminal approval should include session id');
  const approvedTerminalNote = await readFile(
    path.join(tempPatchRoot, `docs/memory/database/tool-approvals/${terminalRequiresApprovalBody.approval.id}.md`),
    'utf8',
  );
  assert(approvedTerminalNote.includes('status: approved'), 'Obsidian approval note should mirror approved status');
  assert(approvedTerminalNote.includes('> [!info] Summary'), 'Obsidian approval note should include summary callout');
  assert(approvedTerminalNote.includes('[[ai-first-ide|AI-first IDE]]'), 'Obsidian approval note should include related wikilinks');
  assert(approvedTerminalNote.includes('Smoke test approval'), 'Obsidian approval note should mirror approval reason');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const approvedTerminalSession = await app.inject({
    method: 'GET',
    url: `/terminal/${approveTerminalBody.approval.result?.sessionId}`,
  });
  assertStatus(approvedTerminalSession.statusCode, 200, 'GET /terminal/:sessionId after tool approval');
  const approvedTerminalSessionBody = approvedTerminalSession.json() as { output: string };
  assert(approvedTerminalSessionBody.output.includes('terminal-policy-smoke'), 'approved terminal command should execute');

  const terminalRejectApproval = await app.inject({
    method: 'POST',
    url: '/terminal/exec',
    payload: { command: 'printf terminal-reject-smoke' },
  });
  assertStatus(terminalRejectApproval.statusCode, 202, 'POST /terminal/exec queues rejectable approval');
  const terminalRejectApprovalBody = terminalRejectApproval.json() as { approval: { id: string } };
  const rejectTerminal = await app.inject({
    method: 'POST',
    url: `/tool-approvals/${terminalRejectApprovalBody.approval.id}/reject`,
    payload: { reason: 'Smoke test rejection' },
  });
  assertStatus(rejectTerminal.statusCode, 200, 'POST /tool-approvals/:approvalId/reject');
  const rejectTerminalBody = rejectTerminal.json() as { approval: { status: string; reason?: string } };
  assert(rejectTerminalBody.approval.status === 'rejected', 'rejected terminal approval should be rejected');
  assert(rejectTerminalBody.approval.reason === 'Smoke test rejection', 'rejected terminal approval should store reason');

  const allowTerminalPolicy = await app.inject({
    method: 'PATCH',
    url: '/settings',
    payload: {
      policy: {
        permissions: {
          bash: {
            '*': 'ask',
            'printf terminal-policy-smoke; sleep 0.5': 'allow',
          },
        },
      },
    },
  });
  assertStatus(allowTerminalPolicy.statusCode, 200, 'PATCH /settings allows selected terminal command');

  const terminalExec = await app.inject({
    method: 'POST',
    url: '/terminal/exec',
    payload: { command: 'printf terminal-policy-smoke; sleep 0.5' },
  });
  assertStatus(terminalExec.statusCode, 201, 'POST /terminal/exec allows approved command');
  const terminalExecBody = terminalExec.json() as { session: { id: string } };
  await new Promise((resolve) => setTimeout(resolve, 50));
  const terminalSession = await app.inject({
    method: 'GET',
    url: `/terminal/${terminalExecBody.session.id}`,
  });
  assertStatus(terminalSession.statusCode, 200, 'GET /terminal/:sessionId after approved exec');
  const terminalSessionBody = terminalSession.json() as { output: string };
  assert(terminalSessionBody.output.includes('terminal-policy-smoke'), 'approved terminal command should execute');

  const deniedSave = await app.inject({
    method: 'PUT',
    url: '/workspace/file',
    payload: {
      path: '../escape.ts',
      content: 'escape\n',
    },
  });
  assertStatus(deniedSave.statusCode, 400, 'PUT /workspace/file denies path traversal');

  const deniedPatch = await app.inject({
    method: 'POST',
    url: '/patches',
    payload: {
      title: 'Denied traversal patch',
      operations: [
        {
          id: 'op-denied',
          kind: 'write_file',
          filePath: '../escape.txt',
          afterContent: 'escape\n',
        },
      ],
    },
  });
  assertStatus(deniedPatch.statusCode, 400, 'POST /patches denies path traversal');

  const deniedAbsolutePatch = await app.inject({
    method: 'POST',
    url: '/patches',
    payload: {
      title: 'Denied absolute patch',
      operations: [
        {
          id: 'op-denied-absolute',
          kind: 'write_file',
          filePath: path.join(tempPatchRoot, 'absolute.txt'),
          afterContent: 'absolute\n',
        },
      ],
    },
  });
  assertStatus(deniedAbsolutePatch.statusCode, 400, 'POST /patches denies absolute path');

  const deniedNodeModulesPatch = await app.inject({
    method: 'POST',
    url: '/patches',
    payload: {
      title: 'Denied protected path patch',
      operations: [
        {
          id: 'op-denied-node-modules',
          kind: 'write_file',
          filePath: 'node_modules/escape.txt',
          afterContent: 'escape\n',
        },
      ],
    },
  });
  assertStatus(deniedNodeModulesPatch.statusCode, 400, 'POST /patches denies protected workspace path');

  const longPath = `${'a/'.repeat(2100)}file.txt`;
  const deniedLongPathPatch = await app.inject({
    method: 'POST',
    url: '/patches',
    payload: {
      title: 'Denied long path patch',
      operations: [
        {
          id: 'op-denied-long-path',
          kind: 'write_file',
          filePath: longPath,
          afterContent: 'escape\n',
        },
      ],
    },
  });
  assertStatus(deniedLongPathPatch.statusCode, 400, 'POST /patches denies overly long file path');

  const createPatch = await app.inject({
    method: 'POST',
    url: '/patches',
    payload: {
      id: 'patch-safe',
      title: 'Safe patch smoke',
      summary: 'Replace safe.txt content',
      sessionId,
      operations: [
        {
          id: 'op-safe',
          kind: 'write_file',
          filePath: 'safe.txt',
          beforeContent: 'before\n',
          afterContent: 'after\n',
        },
      ],
    },
  });
  assertStatus(createPatch.statusCode, 201, 'POST /patches');

  const createPatchBody = createPatch.json() as {
    patch: { id: string; status: string; diff: Array<{ additions: number; deletions: number }> };
  };
  assert(createPatchBody.patch.status === 'pending', 'created patch should be pending');
  assert(createPatchBody.patch.diff[0]?.additions === 1, 'patch diff should count additions');
  assert(createPatchBody.patch.diff[0]?.deletions === 1, 'patch diff should count deletions');

  const approvePatch = await app.inject({ method: 'POST', url: '/patches/patch-safe/approve' });
  assertStatus(approvePatch.statusCode, 200, 'POST /patches/:patchId/approve');

  const applyPatch = await app.inject({ method: 'POST', url: '/patches/patch-safe/apply' });
  assertStatus(applyPatch.statusCode, 200, 'POST /patches/:patchId/apply');
  assert((await readFile(path.join(tempPatchRoot, 'safe.txt'), 'utf8')) === 'after\n', 'patch should write content');

  const rollbackPatch = await app.inject({ method: 'POST', url: '/patches/patch-safe/rollback' });
  assertStatus(rollbackPatch.statusCode, 200, 'POST /patches/:patchId/rollback');
  assert((await readFile(path.join(tempPatchRoot, 'safe.txt'), 'utf8')) === 'before\n', 'rollback should restore content');

  const aiPatchStream = await app.inject({
    method: 'POST',
    url: '/ai/stream',
    payload: {
      ...request,
      id: 'smoke-ai-patch-stream',
      kind: 'edit',
      prompt: 'Create a patch that updates safe.txt through the structured patch tool.',
      stream: true,
      context: {
        ...request.context,
        activeFilePath: 'safe.txt',
        metadata: { patchAfterContent: 'after from ai patch\n' },
      },
      tools: [AI_PATCH_TOOL_SPEC],
    },
  });
  assertStatus(aiPatchStream.statusCode, 200, 'POST /ai/stream persists patch tool call');
  assert(aiPatchStream.body.includes('"type":"tool_call"'), 'AI patch stream should emit tool_call');
  assert(aiPatchStream.body.includes('"patchId":"smoke-ai-patch-stream:patch"'), 'AI patch stream should include backend patchId');

  const aiPatchId = 'smoke-ai-patch-stream:patch';
  const aiPatch = await app.inject({ method: 'GET', url: `/patches/${encodeURIComponent(aiPatchId)}` });
  assertStatus(aiPatch.statusCode, 200, 'GET /patches/:patchId AI-created patch');
  const aiPatchBody = aiPatch.json() as { patch: { review?: { status: string }; status: string } };
  assert(aiPatchBody.patch.status === 'pending', 'AI-created patch should start pending');
  assert(aiPatchBody.patch.review?.status === 'passed', 'AI-created patch should pass precondition review');

  const aiReviewPatch = await app.inject({ method: 'POST', url: `/patches/${encodeURIComponent(aiPatchId)}/review` });
  assertStatus(aiReviewPatch.statusCode, 200, 'POST /patches/:patchId/review');

  const approveAiPatch = await app.inject({ method: 'POST', url: `/patches/${encodeURIComponent(aiPatchId)}/approve` });
  assertStatus(approveAiPatch.statusCode, 200, 'POST /patches/:patchId/approve AI-created patch');

  const applyAiPatch = await app.inject({ method: 'POST', url: `/patches/${encodeURIComponent(aiPatchId)}/apply` });
  assertStatus(applyAiPatch.statusCode, 200, 'POST /patches/:patchId/apply AI-created patch');
  assert((await readFile(path.join(tempPatchRoot, 'safe.txt'), 'utf8')) === 'after from ai patch\n', 'AI-created patch should write content');

  const rollbackAiPatch = await app.inject({ method: 'POST', url: `/patches/${encodeURIComponent(aiPatchId)}/rollback` });
  assertStatus(rollbackAiPatch.statusCode, 200, 'POST /patches/:patchId/rollback AI-created patch');
  assert((await readFile(path.join(tempPatchRoot, 'safe.txt'), 'utf8')) === 'before\n', 'AI-created patch rollback should restore content');

  const stalePatch = await app.inject({
    method: 'POST',
    url: '/patches',
    payload: {
      id: 'patch-stale-precondition',
      title: 'Stale precondition patch',
      operations: [
        {
          id: 'op-stale',
          kind: 'write_file',
          filePath: 'safe.txt',
          beforeContent: 'stale\n',
          afterContent: 'should not apply\n',
        },
      ],
    },
  });
  assertStatus(stalePatch.statusCode, 201, 'POST /patches stale precondition');
  const stalePatchBody = stalePatch.json() as { patch: { review?: { status: string } } };
  assert(stalePatchBody.patch.review?.status === 'blocked', 'stale patch should be blocked before approval');

  const approveStalePatch = await app.inject({ method: 'POST', url: '/patches/patch-stale-precondition/approve' });
  assertStatus(approveStalePatch.statusCode, 409, 'POST /patches/:patchId/approve stale precondition');

  const largePatch = await app.inject({
    method: 'POST',
    url: '/patches',
    payload: {
      title: 'Large patch should be rejected',
      operations: Array.from({ length: 21 }, (_, index) => ({
        id: `op-large-${index}`,
        kind: 'write_file',
        filePath: `bulk-${index}.txt`,
        afterContent: 'x\n',
      })),
    },
  });
  assertStatus(largePatch.statusCode, 400, 'POST /patches rejects too many operations');

  const patchSession = await app.inject({
    method: 'GET',
    url: `/sessions/${sessionId}`,
  });
  assertStatus(patchSession.statusCode, 200, 'GET /sessions/:sessionId patch memory');

  const patchSessionBody = patchSession.json() as {
    state: { patches: Array<{ patchId: string; status: string }> } | null;
  };
  assert(
    patchSessionBody.state?.patches.some((patch) => patch.patchId === 'patch-safe' && patch.status === 'rolled_back') === true,
    'session memory should store final patch outcome',
  );
  const obsidianPatchNote = await readFile(
    path.join(tempPatchRoot, 'docs/memory/database/patches/patch-safe.md'),
    'utf8',
  );
  assert(obsidianPatchNote.includes('status: rolled_back'), 'Obsidian patch note should mirror final patch status');
  assert(obsidianPatchNote.includes('[[session-memory-test]]'), 'Obsidian patch note should link to its session');

  const usageLog = controller.getUsageLog();
  assert(usageLog.list().length > 0, 'usage log should contain records');
  assert(usageLog.list().some((record) => record.role === 'planner'), 'usage log should record role performance');
  const persistedSessions = await readFile(path.join(tempDataRoot, 'sessions.json'), 'utf8');
  assert(persistedSessions.includes(sessionId), 'session memory should persist locally');

  const hydrateDataRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-obsidian-hydrate-smoke-'));
  const { app: hydratedApp } = await createModelGatewayServer({
    logger: false,
    providerConfigs: testProviders,
    workspaceRoot: tempPatchRoot,
    dataDir: hydrateDataRoot,
    workspacePicker: {
      pickDirectory: async () => tempPatchRoot,
    },
  });
  try {
    const hydratedSession = await hydratedApp.inject({
      method: 'GET',
      url: `/sessions/${sessionId}`,
    });
    assertStatus(hydratedSession.statusCode, 200, 'GET /sessions/:sessionId hydrated from Obsidian');
    const hydratedSessionBody = hydratedSession.json() as { state: { decisions: string[] } | null };
    assert(
      hydratedSessionBody.state?.decisions.includes('Use TypeScript strict mode') === true,
      'fresh server should hydrate session state from Obsidian',
    );

    const hydratedRun = await hydratedApp.inject({
      method: 'GET',
      url: `/workflows/runs/${workflowRunId}`,
    });
    assertStatus(hydratedRun.statusCode, 200, 'GET /workflows/runs/:runId hydrated from Obsidian');
    const hydratedRunBody = hydratedRun.json() as { run: { status: string; pausedAtNodeId?: string } };
    assert(hydratedRunBody.run.status === 'paused_approval', 'fresh server should hydrate workflow run status from Obsidian');
    assert(hydratedRunBody.run.pausedAtNodeId === 'node-human-approval', 'fresh server should hydrate paused node from Obsidian');

    const hydratedTrace = await hydratedApp.inject({
      method: 'GET',
      url: `/trace/sessions/${sessionId}`,
    });
    assertStatus(hydratedTrace.statusCode, 200, 'GET /trace/sessions/:sessionId hydrated from Obsidian');
    const hydratedTraceBody = hydratedTrace.json() as { trace: { summary: { totalSteps: number } } };
    assert(hydratedTraceBody.trace.summary.totalSteps > 0, 'fresh server should hydrate trace steps from Obsidian');
  } finally {
    await hydratedApp.close();
    await rm(hydrateDataRoot, { recursive: true, force: true });
  }

  const adapter = controller.getAdapter('openai');
  assert(!!adapter, 'openai adapter should be registered');

  const keyA = createStableCacheKey({
    namespace: 'context-packet',
    version: 'v1',
    parts: [{ b: 2, a: 1 }, ['  hello\nworld  ', true, null]],
  });
  const keyB = createStableCacheKey({
    namespace: 'context-packet',
    version: 'v1',
    parts: [{ a: 1, b: 2 }, ['hello world', true, null]],
  });
  assert(keyA === keyB, 'stable cache key should be order- and whitespace-insensitive');

  const cache = new StableMemoryCache<string>({ defaultTtlMs: 20 });
  cache.set('one', 'value-1', 'session');
  assert(cache.get('one') === 'value-1', 'cache should return freshly stored value');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(cache.get('one') === undefined, 'cache entry should expire after TTL');

  // Agent Run Tests
  const agentRunSessionId = 'agent-run-smoke-test';

  const createRun = await app.inject({
    method: 'POST',
    url: '/agents/runs',
    payload: {
      sessionId: agentRunSessionId,
      goal: 'Test agent run with tool loop',
    },
  });
  assertStatus(createRun.statusCode, 201, 'POST /agents/runs');
  const createRunBody = createRun.json() as { run: { runId: string; status: string; goal: string } };
  const runId = createRunBody.run.runId;
  assert(createRunBody.run.status === 'queued', 'new run should be queued');
  assert(createRunBody.run.goal === 'Test agent run with tool loop', 'run goal should match');

  const getRun = await app.inject({
    method: 'GET',
    url: `/agents/runs/${runId}`,
  });
  assertStatus(getRun.statusCode, 200, 'GET /agents/runs/:runId');
  const getRunBody = getRun.json() as { run: { runId: string; sessionId: string } };
  assert(getRunBody.run.runId === runId, 'get run should return correct run');
  assert(getRunBody.run.sessionId === agentRunSessionId, 'run sessionId should match');

  const listRuns = await app.inject({
    method: 'GET',
    url: '/agents/runs',
    query: { sessionId: agentRunSessionId },
  });
  assertStatus(listRuns.statusCode, 200, 'GET /agents/runs');
  const listRunsBody = listRuns.json() as { runs: Array<{ runId: string }> };
  assert(listRunsBody.runs.some((r) => r.runId === runId), 'list runs should include created run');

  const cancelRun = await app.inject({
    method: 'POST',
    url: `/agents/runs/${runId}/cancel`,
    payload: { reason: 'Smoke test cancellation' },
  });
  assertStatus(cancelRun.statusCode, 200, 'POST /agents/runs/:runId/cancel');
  const cancelRunBody = cancelRun.json() as { run: { status: string; error?: string } };
  assert(cancelRunBody.run.status === 'cancelled', 'cancelled run should have status cancelled');
  assert(cancelRunBody.run.error === 'Smoke test cancellation', 'cancel reason should be recorded');

  const readonlyAgentRun = await app.inject({
    method: 'POST',
    url: '/agents/runs',
    headers: { 'x-ide-capability-profile': 'readonly' },
    payload: {
      sessionId: agentRunSessionId,
      goal: 'Should be denied',
    },
  });
  assertStatus(readonlyAgentRun.statusCode, 403, 'POST /agents/runs denied for readonly');
  const readonlyRunBody = readonlyAgentRun.json() as { code: string; capability?: string };
  assert(readonlyRunBody.code === 'CAPABILITY_DENIED', 'readonly should be denied agent.run.create');
  assert(readonlyRunBody.capability === 'agent.run.create', 'denial should identify agent.run.create capability');

  console.log('OK: all smoke tests passed');
  console.log(`Usage records: ${usageLog.list().length}`);
  console.log(`Session state persisted: decisions=${sessionAfterBody.state?.decisions?.length}, constraints=${sessionAfterBody.state?.constraints?.length}`);
} finally {
  await app.close();
  await new Promise<void>((resolve) => mockOpenAIServer.close(() => resolve()));
  await rm(tempPatchRoot, { recursive: true, force: true });
  await rm(tempDataRoot, { recursive: true, force: true });
}
