import type {
  AgentDefinition,
  AgentDefinitionInput,
  AIRequest,
  AIResponse,
  AIStreamEvent,
  IDESettings,
  IDESettingsUpdate,
  CollaborationResponse,
  CollaborationTeamId,
  CollaborationWorkflowDefinition,
  CollaborationWorkflowInput,
  PatchCreateRequest,
  PatchRecord,
  ProviderId,
  ProviderRuntimeStatusResponse,
  ProviderTestConnectionResponse,
  ToolApprovalRecord,
  ToolApprovalStatus,
  WorkflowRunState,
  WorkflowVersion,
} from '@ide/protocol';

const configuredGatewayUrl = import.meta.env.VITE_MODEL_GATEWAY_URL?.trim();

function defaultGatewayUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:3001';
  }

  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const hostname = window.location.hostname || '127.0.0.1';
  return `${protocol}//${hostname}:3001`;
}

const DEFAULT_GATEWAY_URLS = Array.from(new Set([
  configuredGatewayUrl,
  defaultGatewayUrl(),
  'http://127.0.0.1:3001',
  'http://localhost:3001',
].filter(Boolean))).map((value) => (value as string).replace(/\/+$/, ''));

export const MODEL_GATEWAY_URL = DEFAULT_GATEWAY_URLS[0];
const FETCH_TIMEOUT_MS = 12_000;
const STREAM_CONNECT_TIMEOUT_MS = 120_000;

function wsAgentUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:3001/ai/agent';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = window.location.hostname || '127.0.0.1';
  return `${protocol}//${hostname}:3001/ai/agent`;
}

interface AgentWSMessage {
  type: 'req';
  id: string;
  method: 'agent';
  params: AIRequest;
}

interface AgentWSEvent {
  type: 'event';
  event: string;
  payload: AIStreamEvent;
}

interface AgentWSResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: { text: string };
  error?: { code: string; message: string };
}

export interface WorkspaceSummaryResponse {
  summary: string;
  fileCount: number;
  ready: boolean;
  rootDir: string | null;
  name: string;
}
export interface AgentListResponse {
  agents: AgentDefinition[];
  activeAgentId: string;
}

export interface WorkflowListResponse {
  workflows: CollaborationWorkflowDefinition[];
}

export interface TraceStep {
  id: string;
  type: 'prompt' | 'response' | 'tool_call' | 'tool_result' | 'error' | 'retry' | 'permission' | 'workflow' | 'handoff' | 'approval';
  timestamp: string;
  agentId: string;
  sessionId: string;
  durationMs?: number;
  metadata: Record<string, unknown>;
}

export interface SessionTrace {
  sessionId: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  steps: TraceStep[];
  summary: {
    totalSteps: number;
    totalTokens: number;
    totalCost: number;
    totalDurationMs: number;
    toolCalls: number;
    errors: number;
    retries: number;
  };
}

export interface ObsidianNoteSummary {
  path: string;
  title: string;
  tags: string[];
  aliases: string[];
  excerpt: string;
  content: string;
  updatedAt: string;
  links: string[];
  category: string;
}

export interface ObsidianRagResult {
  chunk: {
    id: string;
    notePath: string;
    title: string;
    heading: string;
    tags: string[];
    content: string;
    excerpt: string;
    startLine: number;
    endLine: number;
    category: string;
  };
  score: number;
  reasons: string[];
  citation: {
    path: string;
    title: string;
    heading: string;
    lines: [number, number];
  };
}

export interface ObsidianMemoryStatsResponse {
  obsidian: {
    ready: boolean;
    total: number;
    chunks?: number;
    byCategory: Record<string, number>;
    tags: string[];
  };
}

export async function listAgents(): Promise<AgentListResponse> {
  const response = await gatewayFetch('/agents');
  if (!response.ok) throw new Error(`List agents failed with ${response.status}`);
  return (await response.json()) as AgentListResponse;
}

export async function activateAgent(agentId: string): Promise<AgentListResponse> {
  const response = await gatewayFetch(`/agents/${encodeURIComponent(agentId)}/activate`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`Activate agent failed with ${response.status}`);
  return (await response.json()) as AgentListResponse;
}

export async function saveAgent(input: AgentDefinitionInput): Promise<AgentListResponse> {
  const response = await gatewayFetch('/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, 'Save agent');
  return (await response.json()) as AgentListResponse;
}

export async function listWorkflows(): Promise<WorkflowListResponse> {
  const response = await gatewayFetch('/workflows');
  if (!response.ok) throw new Error(`List workflows failed with ${response.status}`);
  return (await response.json()) as WorkflowListResponse;
}

export async function saveWorkflow(input: CollaborationWorkflowInput): Promise<WorkflowListResponse> {
  const response = await gatewayFetch('/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, 'Save workflow');
  return (await response.json()) as WorkflowListResponse;
}

export async function deleteWorkflow(workflowId: string): Promise<WorkflowListResponse> {
  const response = await gatewayFetch(`/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await readError(response, 'Delete workflow');
  return (await response.json()) as WorkflowListResponse;
}

export async function getWorkflowRun(runId: string): Promise<WorkflowRunState> {
  const response = await gatewayFetch(`/workflows/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw await readError(response, 'Get workflow run');
  const body = (await response.json()) as { run: WorkflowRunState };
  return body.run;
}

export async function approveWorkflowRun(runId: string, nodeId?: string, reason?: string): Promise<WorkflowRunState> {
  const response = await gatewayFetch(`/workflows/runs/${encodeURIComponent(runId)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, reason }),
  });
  if (!response.ok) throw await readError(response, 'Approve workflow run');
  const body = (await response.json()) as { run: WorkflowRunState };
  return body.run;
}

export async function rejectWorkflowRun(runId: string, nodeId?: string, reason?: string): Promise<WorkflowRunState> {
  const response = await gatewayFetch(`/workflows/runs/${encodeURIComponent(runId)}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, reason }),
  });
  if (!response.ok) throw await readError(response, 'Reject workflow run');
  const body = (await response.json()) as { run: WorkflowRunState };
  return body.run;
}

export async function cancelWorkflowRun(runId: string): Promise<WorkflowRunState> {
  const response = await gatewayFetch(`/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
  if (!response.ok) throw await readError(response, 'Cancel workflow run');
  const body = (await response.json()) as { run: WorkflowRunState };
  return body.run;
}

export async function listWorkflowRuns(workflowId?: string): Promise<WorkflowRunState[]> {
  const path = workflowId
    ? `/workflows/${encodeURIComponent(workflowId)}/runs`
    : '/workflows/runs';
  const response = await gatewayFetch(path);
  if (!response.ok) throw await readError(response, 'List workflow runs');
  const body = (await response.json()) as { runs: WorkflowRunState[] };
  return body.runs;
}

export async function getWorkflowVersions(workflowId: string): Promise<WorkflowVersion[]> {
  const response = await gatewayFetch(`/workflows/${encodeURIComponent(workflowId)}/versions`);
  if (!response.ok) throw await readError(response, 'Get workflow versions');
  const body = (await response.json()) as { versions: WorkflowVersion[] };
  return body.versions;
}

export async function rollbackWorkflow(workflowId: string, version: number): Promise<{ workflow: CollaborationWorkflowDefinition; workflows: CollaborationWorkflowDefinition[] }> {
  const response = await gatewayFetch(`/workflows/${encodeURIComponent(workflowId)}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  if (!response.ok) throw await readError(response, 'Rollback workflow');
  return (await response.json()) as { workflow: CollaborationWorkflowDefinition; workflows: CollaborationWorkflowDefinition[] };
}

export interface WorkflowRunStreamEvent {
  type: string;
  runId: string;
  nodeId?: string;
  status?: string;
  error?: string;
  timestamp?: string;
  run?: WorkflowRunState;
}

export function streamWorkflowRun(
  runId: string,
  onEvent: (event: WorkflowRunStreamEvent) => void,
): { close: () => void } {
  const url = `${MODEL_GATEWAY_URL}/workflows/runs/${encodeURIComponent(runId)}/stream`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (msg) => {
    if (msg.data === '[DONE]') {
      eventSource.close();
      return;
    }
    try {
      const event = JSON.parse(msg.data) as WorkflowRunStreamEvent;
      onEvent(event);
    } catch { /* skip malformed events */ }
  };

  eventSource.onerror = () => {
    eventSource.close();
  };

  return { close: () => eventSource.close() };
}

export async function listTraces(): Promise<SessionTrace[]> {
  const response = await gatewayFetch('/trace/sessions');
  if (!response.ok) throw new Error(`List traces failed with ${response.status}`);
  const body = (await response.json()) as { traces: SessionTrace[] };
  return body.traces;
}

export interface NodeTraceStep {
  id: string;
  type: string;
  timestamp: string;
  agentId: string;
  sessionId: string;
  durationMs?: number;
  metadata: Record<string, unknown>;
}

export async function getNodeTraceSteps(nodeId: string, sessionId?: string): Promise<NodeTraceStep[]> {
  const params = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const response = await gatewayFetch(`/trace/nodes/${encodeURIComponent(nodeId)}${params}`);
  if (!response.ok) throw await readError(response, 'Get node trace steps');
  const body = (await response.json()) as { steps: NodeTraceStep[] };
  return body.steps;
}

export async function getObsidianMemoryStats(): Promise<ObsidianMemoryStatsResponse> {
  const response = await gatewayFetch('/memory/obsidian/stats');
  if (!response.ok) throw new Error(`Get Obsidian memory stats failed with ${response.status}`);
  return (await response.json()) as ObsidianMemoryStatsResponse;
}

export async function searchObsidianMemory(query: string): Promise<ObsidianNoteSummary[]> {
  const response = await gatewayFetch('/memory/obsidian/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw await readError(response, 'Search Obsidian memory');
  const body = (await response.json()) as { notes: ObsidianNoteSummary[] };
  return body.notes;
}

export async function retrieveObsidianRag(query: string, limit = 8): Promise<ObsidianRagResult[]> {
  const response = await gatewayFetch('/memory/obsidian/rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!response.ok) throw await readError(response, 'Retrieve Obsidian RAG');
  const body = (await response.json()) as { results: ObsidianRagResult[] };
  return body.results;
}

export async function runCollaboration(input: {
  goal: string;
  context: AIRequest['context'];
  team?: CollaborationTeamId;
  workflowId?: string;
  maxTokensPerRole?: number;
  temperature?: number;
}): Promise<CollaborationResponse> {
  const response = await gatewayFetch('/ai/collaborate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      goal: input.goal,
      kind: 'edit',
      team: input.team ?? 'auto',
      workflowId: input.workflowId,
      context: input.context,
      maxTokensPerRole: input.maxTokensPerRole,
      temperature: input.temperature,
    }),
  }, STREAM_CONNECT_TIMEOUT_MS);

  if (!response.ok) {
    throw await readError(response, 'Run multi-agent collaboration');
  }

  return (await response.json()) as CollaborationResponse;
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

export interface ToolApprovalListResponse {
  approvals: ToolApprovalRecord[];
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

async function gatewayFetch(path: string, init?: RequestInit, connectTimeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const errors: string[] = [];

  for (const baseUrl of DEFAULT_GATEWAY_URLS) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort('gateway-timeout'), connectTimeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? controller.signal,
      });
      if (response.ok || response.status < 500) {
        return response;
      }
      errors.push(`${baseUrl} -> HTTP ${response.status}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        errors.push(`${baseUrl} -> timeout after ${connectTimeoutMs / 1000}s`);
      } else {
        errors.push(`${baseUrl} -> unreachable`);
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }

  throw new Error(`Unable to reach model gateway. Tried: ${DEFAULT_GATEWAY_URLS.join(', ')}. ${errors.join('; ')}`);
}

function buildAIRequest(prompt: string, context: Partial<AIRequest> = {}): AIRequest {
  return {
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
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<AIStreamEvent> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += value;
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const raw of events) {
        const payload = raw
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');

        if (!payload || payload === '[DONE]') continue;

        try {
          yield JSON.parse(payload) as AIStreamEvent;
        } catch {
          yield { type: 'warning', message: 'Skipped malformed stream event from model gateway.' };
        }
      }
    }

    if (buffer.trim()) {
      const last = buffer.trim();
      if (last !== 'data: [DONE]') {
        const payload = last
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('\n');
        if (payload && payload !== '[DONE]') {
          try {
            yield JSON.parse(payload) as AIStreamEvent;
          } catch {
            yield { type: 'warning', message: 'Skipped malformed stream event from model gateway.' };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function streamAIResponse(
  prompt: string,
  context: Partial<AIRequest> = {},
  onEvent?: (event: AIStreamEvent) => void,
): Promise<string> {
  const request = { ...buildAIRequest(prompt, context), stream: true };

  const response = await gatewayFetch('/ai/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }, STREAM_CONNECT_TIMEOUT_MS);

  if (!response.ok || !response.body) {
    throw new Error(`Model gateway stream failed with ${response.status}`);
  }

  let assembledText = '';

  for await (const event of parseSSEStream(response.body)) {
    onEvent?.(event);
    if (event.type === 'delta') {
      assembledText += event.text;
    }
    if (event.type === 'end') break;
  }

  return assembledText;
}

export async function streamAIResponseWS(
  prompt: string,
  context: Partial<AIRequest> = {},
  onEvent?: (event: AIStreamEvent) => void,
): Promise<string> {
  const request = { ...buildAIRequest(prompt, context), stream: true };
  const msgId = crypto.randomUUID();

  const url = configuredGatewayUrl
    ? configuredGatewayUrl.replace(/^http/, 'ws') + '/ai/agent'
    : wsAgentUrl();

  const socket = new WebSocket(url);
  const collected = { text: '' };

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket agent connection timed out'));
      }, STREAM_CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        window.clearTimeout(timeout);
        socket.send(JSON.stringify({
          type: 'req',
          id: msgId,
          method: 'agent',
          params: request,
        } satisfies AgentWSMessage));
      };

      socket.onmessage = (evt) => {
        const msg = JSON.parse(evt.data as string) as AgentWSEvent | AgentWSResponse;

        if (msg.type === 'event') {
          onEvent?.(msg.payload);
          if (msg.payload.type === 'delta') {
            collected.text += msg.payload.text;
          }
          return;
        }

        if (msg.type === 'res' && msg.id === msgId) {
          if (!msg.ok) {
            reject(new Error(msg.error?.message ?? 'Agent request failed'));
          } else {
            resolve();
          }
          return;
        }
      };

      socket.onerror = () => {
        reject(new Error('WebSocket agent connection failed'));
      };

      socket.onclose = (evt) => {
        if (evt.code !== 1000 && evt.code !== 1005) {
          reject(new Error(`WebSocket closed unexpectedly (code ${evt.code})`));
        }
      };
    });

    return collected.text;
  } catch {
    return streamAIResponse(prompt, context, onEvent);
  }
}

export async function generateAIResponse(prompt: string, context: Partial<AIRequest> = {}): Promise<AIResponse> {
  const request = buildAIRequest(prompt, context);

  const response = await gatewayFetch('/ai/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw await readError(response, 'Generate AI response');
  }

  return (await response.json()) as AIResponse;
}

async function readPatchResponse(response: Response, action: string): Promise<PatchRecord> {
  if (!response.ok) {
    throw await readError(response, action);
  }

  const body = (await response.json()) as { patch: PatchRecord };
  return body.patch;
}

export async function listPatches(): Promise<PatchRecord[]> {
  const response = await gatewayFetch('/patches');
  if (!response.ok) {
    throw new Error(`List patches failed with ${response.status}`);
  }
  const body = (await response.json()) as { patches: PatchRecord[] };
  return body.patches;
}

export async function createPatch(input: PatchCreateRequest): Promise<PatchRecord> {
  const response = await gatewayFetch('/patches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readPatchResponse(response, 'Create patch');
}

export async function approvePatch(patchId: string): Promise<PatchRecord> {
  const response = await gatewayFetch(`/patches/${patchId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Approve patch');
}

export async function rejectPatch(patchId: string): Promise<PatchRecord> {
  const response = await gatewayFetch(`/patches/${patchId}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Reject patch');
}

export async function reviewPatch(patchId: string): Promise<PatchRecord> {
  const response = await gatewayFetch(`/patches/${patchId}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Review patch');
}

export async function applyPatch(patchId: string): Promise<PatchRecord> {
  const response = await gatewayFetch(`/patches/${patchId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Apply patch');
}

export async function rollbackPatch(patchId: string): Promise<PatchRecord> {
  const response = await gatewayFetch(`/patches/${patchId}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  return readPatchResponse(response, 'Rollback patch');
}

export async function listToolApprovals(status?: ToolApprovalStatus): Promise<ToolApprovalRecord[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const response = await gatewayFetch(`/tool-approvals${query}`);
  if (!response.ok) {
    throw await readError(response, 'List tool approvals');
  }
  const body = (await response.json()) as ToolApprovalListResponse;
  return body.approvals;
}

async function readToolApprovalResponse(response: Response, action: string): Promise<ToolApprovalRecord> {
  if (!response.ok) {
    throw await readError(response, action);
  }
  const body = (await response.json()) as { approval: ToolApprovalRecord };
  return body.approval;
}

export async function approveToolApproval(approvalId: string, reason?: string): Promise<ToolApprovalRecord> {
  const response = await gatewayFetch(`/tool-approvals/${encodeURIComponent(approvalId)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return readToolApprovalResponse(response, 'Approve tool approval');
}

export async function rejectToolApproval(approvalId: string, reason?: string): Promise<ToolApprovalRecord> {
  const response = await gatewayFetch(`/tool-approvals/${encodeURIComponent(approvalId)}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return readToolApprovalResponse(response, 'Reject tool approval');
}

export async function getSettings(): Promise<IDESettings> {
  const response = await gatewayFetch('/settings');
  if (!response.ok) {
    throw await readError(response, 'Get settings');
  }
  const body = (await response.json()) as { settings: IDESettings };
  return body.settings;
}

export async function updateSettings(input: IDESettingsUpdate): Promise<IDESettings> {
  const response = await gatewayFetch('/settings', {
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

export async function updateLocalProvider(providerId: ProviderId, provider: Record<string, unknown>): Promise<IDESettings> {
  const response = await gatewayFetch(`/settings/providers/${encodeURIComponent(providerId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(provider),
  });
  if (!response.ok) {
    throw await readError(response, 'Update provider settings');
  }
  const body = (await response.json()) as { settings: IDESettings };
  return body.settings;
}

export async function updateWorkspaceOverride(workspaceId: string, override: Record<string, unknown> | null): Promise<IDESettings> {
  const response = await gatewayFetch(`/settings/workspace/${encodeURIComponent(workspaceId)}`, {
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
  const response = await gatewayFetch('/settings/provider-status');
  if (!response.ok) {
    throw await readError(response, 'Get provider status');
  }
  return (await response.json()) as ProviderRuntimeStatusResponse;
}

export async function testProviderConnection(providerId: ProviderId): Promise<ProviderTestConnectionResponse> {
  const response = await gatewayFetch(`/settings/providers/${providerId}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!response.ok) {
    throw await readError(response, 'Test provider connection');
  }
  return (await response.json()) as ProviderTestConnectionResponse;
}

export async function getWorkspaceSummary(): Promise<WorkspaceSummaryResponse> {
  const response = await gatewayFetch('/workspace/summary');
  if (!response.ok) {
    throw await readError(response, 'Get workspace summary');
  }
  return (await response.json()) as WorkspaceSummaryResponse;
}

export async function listWorkspaceFiles(): Promise<WorkspaceFilesResponse> {
  const response = await gatewayFetch('/workspace/files');
  if (!response.ok) {
    throw await readError(response, 'List workspace files');
  }
  return (await response.json()) as WorkspaceFilesResponse;
}

export async function indexWorkspace(rootDir: string): Promise<WorkspaceIndexResponse> {
  const response = await gatewayFetch('/workspace/index', {
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
  const response = await gatewayFetch('/workspace/pick', {
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
  const response = await gatewayFetch(`/workspace/file?path=${encodeURIComponent(filePath)}`);
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
  const response = await gatewayFetch('/workspace/file', {
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
    const response = await gatewayFetch('/terminal/output');
    if (!response.ok) return '';
    const body = (await response.json()) as { output: string };
    return body.output;
  } catch {
    return '';
  }
}
