import { AI_PATCH_TOOL_SPEC, type AIRequest } from '@ide/protocol';
import { createStableCacheKey, StableMemoryCache } from './index';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const testProviders: ProviderConnectionConfig[] = [
  {
    providerId: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKeyEnv: 'OPENAI_API_KEY',
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
const { app, controller } = await createModelGatewayServer({
  logger: false,
  providerConfigs: testProviders,
  dataDir: tempDataRoot,
  workspacePicker: {
    pickDirectory: async () => process.cwd(),
  },
});
const tempPatchRoot = await mkdtemp(path.join(os.tmpdir(), 'ide-patch-smoke-'));

try {
  const health = await app.inject({ method: 'GET', url: '/health' });
  assertStatus(health.statusCode, 200, 'GET /health');

  const settings = await app.inject({ method: 'GET', url: '/settings' });
  assertStatus(settings.statusCode, 200, 'GET /settings');

  const settingsBody = settings.json() as {
    settings: {
      memory: { dataDir: string; persistSessionMemory: boolean };
      localProviders: Array<{ providerId: 'ollama' | 'vllm'; enabled: boolean; baseUrl: string; models: string[]; timeoutMs: number }>;
    };
  };
  assert(settingsBody.settings.memory.dataDir === tempDataRoot, 'settings should use local data dir');
  assert(settingsBody.settings.localProviders.some((provider) => provider.providerId === 'ollama'), 'settings should include Ollama');

  const enableVllmSettings = await app.inject({
    method: 'PATCH',
    url: '/settings',
    payload: {
      localProviders: settingsBody.settings.localProviders.map((provider) =>
        provider.providerId === 'vllm' ? { ...provider, enabled: true, models: ['local-model'] } : provider,
      ),
    },
  });
  assertStatus(enableVllmSettings.statusCode, 200, 'PATCH /settings hot-reloads vllm provider');

  const providerStatus = await app.inject({ method: 'GET', url: '/settings/provider-status' });
  assertStatus(providerStatus.statusCode, 200, 'GET /settings/provider-status');
  const providerStatusBody = providerStatus.json() as {
    localOnlyReady: boolean;
    providers: Array<{ providerId: string; registered: boolean; healthy: boolean; modelIds: string[] }>;
  };
  assert(providerStatusBody.providers.some((provider) => provider.providerId === 'vllm' && provider.registered), 'enabled vllm should be registered without restart');
  assert(providerStatusBody.providers.some((provider) => provider.providerId === 'custom' && provider.modelIds.includes('local-model')), 'static custom provider should stay registered after reload');

  const testVllm = await app.inject({ method: 'POST', url: '/settings/providers/vllm/test' });
  assertStatus(testVllm.statusCode, 200, 'POST /settings/providers/:providerId/test');
  const testVllmBody = testVllm.json() as { ok: boolean; provider: { providerId: string } };
  assert(testVllmBody.ok && testVllmBody.provider.providerId === 'vllm', 'vllm test connection should use runtime adapter');

  const workspaceOverrideSettings = await app.inject({
    method: 'PATCH',
    url: '/settings',
    payload: {
      workspaceOverrides: {
        'workspace-alt': {
          workspaceId: 'workspace-alt',
          policy: { defaultStrategy: 'latencyOptimized' },
          localProviderIds: ['vllm'],
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
      settings: { localProviders: Array<{ providerId: 'ollama' | 'vllm'; enabled: boolean; baseUrl: string; models: string[]; timeoutMs: number }> };
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
    generateBody.providerId === 'custom' || generateBody.providerId === 'vllm' || generateBody.providerId === 'ollama',
    'privacy mode should force a local provider',
  );
  assert(generateBody.metadata?.sessionId === sessionId, 'missing sessionId in metadata');

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

  const workspaceIndex = await app.inject({
    method: 'POST',
    url: '/workspace/index',
    payload: { rootDir: process.cwd() },
  });
  assertStatus(workspaceIndex.statusCode, 200, 'POST /workspace/index');

  const workspacePick = await app.inject({
    method: 'POST',
    url: '/workspace/pick',
  });
  assertStatus(workspacePick.statusCode, 200, 'POST /workspace/pick');
  const workspacePickBody = workspacePick.json() as { rootDir: string };
  assert(workspacePickBody.rootDir === process.cwd(), 'workspace picker should return injected root');

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
  assertStatus(deniedNodeModulesPatch.statusCode, 403, 'POST /patches denies protected workspace path');

  const longPath = `${'a/'.repeat(300)}file.txt`;
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

  const usageLog = controller.getUsageLog();
  assert(usageLog.list().length > 0, 'usage log should contain records');
  assert(usageLog.list().some((record) => record.role === 'planner'), 'usage log should record role performance');
  const persistedSessions = await readFile(path.join(tempDataRoot, 'sessions.json'), 'utf8');
  assert(persistedSessions.includes(sessionId), 'session memory should persist locally');

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

  console.log('OK: all smoke tests passed');
  console.log(`Usage records: ${usageLog.list().length}`);
  console.log(`Session state persisted: decisions=${sessionAfterBody.state?.decisions?.length}, constraints=${sessionAfterBody.state?.constraints?.length}`);
} finally {
  await app.close();
  await rm(tempPatchRoot, { recursive: true, force: true });
  await rm(tempDataRoot, { recursive: true, force: true });
}
