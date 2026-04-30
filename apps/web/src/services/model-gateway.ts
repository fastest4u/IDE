import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  IDESettings,
  IDESettingsUpdate,
  PatchCreateRequest,
  PatchRecord,
  ProviderId,
  ProviderRuntimeStatusResponse,
  ProviderTestConnectionResponse,
} from '@ide/protocol';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:3001';

export interface WorkspaceSummaryResponse {
  summary: string;
  fileCount: number;
  ready: boolean;
  rootDir: string | null;
  name: string;
}

export interface WorkspaceFilesResponse {
  files: string[];
  count: number;
}

export interface WorkspaceFileResponse {
  filePath: string;
  content: string;
}

export interface WorkspaceSaveResponse {
  filePath: string;
  bytes: number;
  updatedAt: string;
}

export interface WorkspaceIndexResponse {
  rootDir: string;
  summary: string;
  fileCount: number;
}

export interface WorkspacePickResponse {
  rootDir: string;
}

export interface ModelGatewayError extends Error {
  code?: string;
}

async function readError(response: Response, action: string): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string; code?: string };
    const suffix = body.message ? `: ${body.message}` : '';
    const error = new Error(`${action} failed with ${response.status}${suffix}`) as ModelGatewayError;
    error.code = body.code;
    return error;
  } catch {
    return new Error(`${action} failed with ${response.status}`);
  }
}

export async function generateAIResponse(prompt: string, context: Partial<AIRequest> = {}): Promise<AIResponse> {
  const request: AIRequest = {
    id: crypto.randomUUID(),
    kind: context.kind ?? 'chat',
    prompt,
    context: {
      workspaceId: context.context?.workspaceId ?? 'workspace-local',
      sessionId: context.context?.sessionId ?? 'session-local',
      userId: context.context?.userId,
      activeFilePath: context.context?.activeFilePath,
      selectedText: context.context?.selectedText,
      openFiles: context.context?.openFiles,
      gitDiff: context.context?.gitDiff,
      terminalOutput: context.context?.terminalOutput,
      diagnostics: context.context?.diagnostics,
      repoSummary: context.context?.repoSummary,
      language: context.context?.language,
      metadata: context.context?.metadata,
    },
    preferredCapabilities: context.preferredCapabilities,
    preferredModelTier: context.preferredModelTier,
    strategy: context.strategy,
    maxTokens: context.maxTokens,
    temperature: context.temperature,
    stream: false,
    tools: context.tools,
  };

  const response = await fetch(`${DEFAULT_GATEWAY_URL}/ai/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Model gateway request failed with ${response.status}`);
  }

  return (await response.json()) as AIResponse;
}

export async function streamAIResponse(
  prompt: string,
  context: Partial<AIRequest> = {},
  onEvent?: (event: AIStreamEvent) => void,
): Promise<string> {
  const request: AIRequest = {
    id: crypto.randomUUID(),
    kind: context.kind ?? 'chat',
    prompt,
    context: {
      workspaceId: context.context?.workspaceId ?? 'workspace-local',
      sessionId: context.context?.sessionId ?? 'session-local',
      userId: context.context?.userId,
      activeFilePath: context.context?.activeFilePath,
      selectedText: context.context?.selectedText,
      openFiles: context.context?.openFiles,
      gitDiff: context.context?.gitDiff,
      terminalOutput: context.context?.terminalOutput,
      diagnostics: context.context?.diagnostics,
      repoSummary: context.context?.repoSummary,
      language: context.context?.language,
      metadata: context.context?.metadata,
    },
    preferredCapabilities: context.preferredCapabilities,
    preferredModelTier: context.preferredModelTier,
    strategy: context.strategy,
    maxTokens: context.maxTokens,
    temperature: context.temperature,
    stream: true,
    tools: context.tools,
  };

  const response = await fetch(`${DEFAULT_GATEWAY_URL}/ai/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Model gateway stream failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assembledText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part
        .split('\n')
        .find((entry) => entry.startsWith('data: '))
        ?.slice(6);

      if (!line) continue;

      const event = JSON.parse(line) as AIStreamEvent;
      onEvent?.(event);
      if (event.type === 'delta') {
        assembledText += event.text;
      }
    }
  }

  return assembledText;
}

async function readPatchResponse(response: Response, action: string): Promise<PatchRecord> {
  if (!response.ok) {
    throw await readError(response, action);
  }

  const body = (await response.json()) as { patch: PatchRecord };
  return body.patch;
}

export async function listPatches(): Promise<PatchRecord[]> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/patches`);
  if (!response.ok) {
    throw new Error(`List patches failed with ${response.status}`);
  }
  const body = (await response.json()) as { patches: PatchRecord[] };
  return body.patches;
}

export async function createPatch(input: PatchCreateRequest): Promise<PatchRecord> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/patches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readPatchResponse(response, 'Create patch');
}

export async function approvePatch(patchId: string): Promise<PatchRecord> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/patches/${patchId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Approve patch');
}

export async function rejectPatch(patchId: string): Promise<PatchRecord> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/patches/${patchId}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Reject patch');
}

export async function reviewPatch(patchId: string): Promise<PatchRecord> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/patches/${patchId}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Review patch');
}

export async function applyPatch(patchId: string): Promise<PatchRecord> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/patches/${patchId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Apply patch');
}

export async function rollbackPatch(patchId: string): Promise<PatchRecord> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/patches/${patchId}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Rollback patch');
}

export async function getSettings(): Promise<IDESettings> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/settings`);
  if (!response.ok) {
    throw new Error(`Get settings failed with ${response.status}`);
  }
  const body = (await response.json()) as { settings: IDESettings };
  return body.settings;
}

export async function updateSettings(input: IDESettingsUpdate): Promise<IDESettings> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw await readError(response, 'Update settings');
  }
  const body = (await response.json()) as { settings: IDESettings };
  return body.settings;
}

export async function updateWorkspaceOverride(workspaceId: string, override: Record<string, unknown> | null): Promise<IDESettings> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/settings/workspace/${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ override }),
  });
  if (!response.ok) {
    throw await readError(response, 'Update workspace override');
  }
  const body = (await response.json()) as { settings: IDESettings };
  return body.settings;
}

export async function getProviderRuntimeStatus(): Promise<ProviderRuntimeStatusResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/settings/provider-status`);
  if (!response.ok) {
    throw await readError(response, 'Get provider status');
  }
  return (await response.json()) as ProviderRuntimeStatusResponse;
}

export async function testProviderConnection(providerId: ProviderId): Promise<ProviderTestConnectionResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/settings/providers/${providerId}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    throw await readError(response, 'Test provider connection');
  }
  return (await response.json()) as ProviderTestConnectionResponse;
}

export async function getWorkspaceSummary(): Promise<WorkspaceSummaryResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/workspace/summary`);
  if (!response.ok) {
    throw await readError(response, 'Get workspace summary');
  }
  return (await response.json()) as WorkspaceSummaryResponse;
}

export async function listWorkspaceFiles(): Promise<WorkspaceFilesResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/workspace/files`);
  if (!response.ok) {
    throw await readError(response, 'List workspace files');
  }
  return (await response.json()) as WorkspaceFilesResponse;
}

export async function indexWorkspace(rootDir: string): Promise<WorkspaceIndexResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/workspace/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootDir }),
  });
  if (!response.ok) {
    throw await readError(response, 'Index workspace');
  }
  return (await response.json()) as WorkspaceIndexResponse;
}

export async function pickWorkspaceDirectory(defaultPath?: string): Promise<WorkspacePickResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/workspace/pick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(defaultPath ? { defaultPath } : {}),
  });
  if (!response.ok) {
    throw await readError(response, 'Pick workspace');
  }
  return (await response.json()) as WorkspacePickResponse;
}

export async function getWorkspaceFile(filePath: string): Promise<WorkspaceFileResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/workspace/file?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) {
    throw await readError(response, 'Get workspace file');
  }
  return (await response.json()) as WorkspaceFileResponse;
}

export async function saveWorkspaceFile(
  filePath: string,
  content: string,
  expectedContent?: string,
): Promise<WorkspaceSaveResponse> {
  const response = await fetch(`${DEFAULT_GATEWAY_URL}/workspace/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: filePath, content, expectedContent }),
  });
  if (!response.ok) {
    throw await readError(response, 'Save workspace file');
  }
  return (await response.json()) as WorkspaceSaveResponse;
}

export async function fetchTerminalOutput(): Promise<string> {
  try {
    const response = await fetch(`${DEFAULT_GATEWAY_URL}/terminal/output`);
    if (!response.ok) return '';
    const body = (await response.json()) as { output: string };
    return body.output;
  } catch {
    return '';
  }
}
