import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { MemoryRecord, PatchMemory, TaskState, ToolApprovalRecord, WorkflowRunState } from '@ide/protocol';

import { WorkspaceWriter } from './workspace-writer';
import type { SessionTrace } from './telemetry/trace-service';

export interface ObsidianDatabaseOptions {
  workspaceRoot?: string;
  enabled?: boolean;
  baseDir?: string;
}

type FrontmatterValue = string | number | boolean | string[] | null | undefined;

interface ObsidianRecordInput {
  collection: string;
  id: string;
  title: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
  properties?: Record<string, FrontmatterValue>;
  body: string;
}

export interface ObsidianDatabaseRecordSummary {
  filePath: string;
  collection: string;
  title?: string;
  type?: string;
  status?: string;
  created?: string;
  updated?: string;
  tags: string[];
  properties: Record<string, unknown>;
}

export class ObsidianDatabaseService {
  private readonly baseDir: string;
  private readonly enabled: boolean;
  private writer: WorkspaceWriter | null = null;
  private workspaceRoot: string | null = null;

  constructor(options: ObsidianDatabaseOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.baseDir = normalizeBaseDir(options.baseDir ?? 'docs/memory/database');
    if (options.workspaceRoot) {
      this.setWorkspaceRoot(options.workspaceRoot);
    }
  }

  setWorkspaceRoot(rootDir: string | null | undefined): void {
    const normalized = rootDir?.trim();
    if (!normalized) {
      this.workspaceRoot = null;
      this.writer = null;
      return;
    }

    this.workspaceRoot = path.resolve(normalized);
    if (this.writer) {
      this.writer.setWorkspaceRoot(this.workspaceRoot);
    } else {
      this.writer = new WorkspaceWriter(this.workspaceRoot);
    }
  }

  isReady(): boolean {
    return this.enabled && Boolean(this.workspaceRoot && this.writer);
  }

  async writeToolApproval(record: ToolApprovalRecord): Promise<string | undefined> {
    return this.writeRecord({
      collection: 'tool-approvals',
      id: record.id,
      title: `Tool Approval ${record.id}`,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      tags: ['project/my-ide', 'ai/database', 'approval/tool', `status/${record.status}`, `tool/${record.tool}`],
      properties: {
        type: 'tool-approval',
        approvalId: record.id,
        tool: record.tool,
        action: record.action,
        status: record.status,
        command: record.command,
        cwd: record.cwd,
        targetSessionId: record.targetSessionId,
        decidedAt: record.decidedAt,
        resultSessionId: record.result?.sessionId,
        exitCode: record.result?.exitCode ?? undefined,
      },
      body: formatToolApprovalBody(record),
    });
  }

  async writeTaskState(state: TaskState): Promise<string | undefined> {
    return this.writeRecord({
      collection: 'sessions',
      id: state.sessionId,
      title: `Agent Session ${state.sessionId}`,
      status: 'active',
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      tags: ['project/my-ide', 'ai/database', 'agent/session', 'status/active'],
      properties: {
        type: 'agent-session',
        sessionId: state.sessionId,
        status: 'active',
        decisionCount: state.decisions.length,
        constraintCount: state.constraints.length,
        patchCount: state.patches.length,
        memoryCount: state.memory.length,
        providerUsageCount: state.providerUsage.length,
      },
      body: formatTaskStateBody(state),
    });
  }

  async writePatchMemory(sessionId: string, patch: PatchMemory): Promise<string | undefined> {
    return this.writeRecord({
      collection: 'patches',
      id: patch.patchId,
      title: `Patch ${patch.title}`,
      status: patch.status,
      createdAt: patch.timestamp,
      updatedAt: patch.timestamp,
      tags: ['project/my-ide', 'ai/database', 'patch/memory', `status/${patch.status}`],
      properties: {
        type: 'patch-memory',
        patchId: patch.patchId,
        sessionId,
        status: patch.status,
        filePath: patch.filePath,
        timestamp: patch.timestamp,
      },
      body: formatPatchMemoryBody(sessionId, patch),
    });
  }

  async writeMemoryRecord(record: MemoryRecord): Promise<string | undefined> {
    return this.writeRecord({
      collection: 'memory-records',
      id: record.id,
      title: `Memory ${record.kind} ${record.id}`,
      status: record.kind,
      createdAt: record.timestamp,
      updatedAt: record.timestamp,
      tags: ['project/my-ide', 'ai/database', 'agent/memory', `memory/${record.kind}`],
      properties: {
        type: 'memory-record',
        memoryId: record.id,
        sessionId: record.sessionId,
        kind: record.kind,
        source: record.source,
        timestamp: record.timestamp,
      },
      body: formatMemoryRecordBody(record),
    });
  }

  async writeTrace(trace: SessionTrace): Promise<string | undefined> {
    const updatedAt = trace.endedAt ?? trace.steps[trace.steps.length - 1]?.timestamp ?? trace.startedAt;
    return this.writeRecord({
      collection: 'traces',
      id: trace.sessionId,
      title: `Trace ${trace.sessionId}`,
      status: trace.endedAt ? 'ended' : 'active',
      createdAt: trace.startedAt,
      updatedAt,
      tags: ['project/my-ide', 'ai/database', 'trace/session', trace.endedAt ? 'status/ended' : 'status/active'],
      properties: {
        type: 'session-trace',
        sessionId: trace.sessionId,
        agentId: trace.agentId,
        status: trace.endedAt ? 'ended' : 'active',
        endedAt: trace.endedAt,
        totalSteps: trace.summary.totalSteps,
        totalTokens: trace.summary.totalTokens,
        totalCost: trace.summary.totalCost,
        toolCalls: trace.summary.toolCalls,
        errors: trace.summary.errors,
        retries: trace.summary.retries,
      },
      body: formatTraceBody(trace),
    });
  }

  async writeWorkflowRun(run: WorkflowRunState): Promise<string | undefined> {
    return this.writeRecord({
      collection: 'workflow-runs',
      id: run.runId,
      title: `Workflow Run ${run.runId}`,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      tags: ['project/my-ide', 'ai/database', 'workflow/run', `status/${run.status}`],
      properties: {
        type: 'workflow-run',
        runId: run.runId,
        workflowId: run.workflowId,
        collaborationId: run.collaborationId,
        sessionId: run.outputs[0]?.id?.split(':')[0],
        status: run.status,
        pausedAtNodeId: run.pausedAtNodeId,
        workflowVersion: run.workflowVersion,
        nodeCount: run.nodeStates.length,
        outputCount: run.outputs.length,
        completedNodeCount: run.nodeStates.filter((node) => node.status === 'completed').length,
        failedNodeCount: run.nodeStates.filter((node) => node.status === 'failed').length,
      },
      body: formatWorkflowRunBody(run),
    });
  }

  async readToolApprovals(): Promise<ToolApprovalRecord[]> {
    return this.readJsonRecords<ToolApprovalRecord>('tool-approvals', 'Raw Record', isToolApprovalRecord);
  }

  async readTaskStates(): Promise<TaskState[]> {
    return this.readJsonRecords<TaskState>('sessions', 'Raw State', isTaskState);
  }

  async readTraces(): Promise<SessionTrace[]> {
    return this.readJsonRecords<SessionTrace>('traces', 'Raw Trace', isSessionTrace);
  }

  async readWorkflowRuns(): Promise<WorkflowRunState[]> {
    return this.readJsonRecords<WorkflowRunState>('workflow-runs', 'Raw Workflow Run', isWorkflowRunState);
  }

  async listRecords(filter: { collection?: string; type?: string; status?: string } = {}): Promise<ObsidianDatabaseRecordSummary[]> {
    const collections = filter.collection ? [filter.collection] : await this.listCollections();
    const records: ObsidianDatabaseRecordSummary[] = [];
    for (const collection of collections) {
      for (const note of await this.readCollectionNotes(collection)) {
        const properties = parseFrontmatter(note.content);
        const summary: ObsidianDatabaseRecordSummary = {
          filePath: note.filePath,
          collection: stringFromProperty(properties.collection) ?? collection,
          title: stringFromProperty(properties.title),
          type: stringFromProperty(properties.type),
          status: stringFromProperty(properties.status),
          created: stringFromProperty(properties.created),
          updated: stringFromProperty(properties.updated),
          tags: Array.isArray(properties.tags) ? properties.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          properties,
        };
        if (filter.type && summary.type !== filter.type) continue;
        if (filter.status && summary.status !== filter.status) continue;
        records.push(summary);
      }
    }
    return records.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  }

  private async writeRecord(input: ObsidianRecordInput): Promise<string | undefined> {
    if (!this.isReady() || !this.writer) {
      return undefined;
    }

    const relativePath = `${this.baseDir}/${normalizePathSegment(input.collection)}/${slugify(input.id)}.md`;
    const content = formatRecord(input);
    const target = this.writer.resolvePath(relativePath);
    const resolvedBaseDir = this.writer.resolvePath(this.baseDir).absolutePath;
    const resolvedTargetPath = path.resolve(target.absolutePath);
    if (!resolvedTargetPath.startsWith(resolvedBaseDir)) {
      throw new Error(`Database path escapes base dir: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
    await this.writer.writeFile(target.relativePath, content);
    return target.relativePath;
  }

  private async readJsonRecords<T>(
    collection: string,
    heading: string,
    guard: (value: unknown) => value is T,
  ): Promise<T[]> {
    const records: T[] = [];
    for (const note of await this.readCollectionNotes(collection)) {
      const parsed = parseJsonSection(note.content, heading);
      if (guard(parsed)) {
        records.push(parsed);
      }
    }
    return records;
  }

  private async readCollectionNotes(collection: string): Promise<Array<{ filePath: string; content: string }>> {
    if (!this.isReady() || !this.writer) return [];
    const collectionPath = `${this.baseDir}/${normalizePathSegment(collection)}`;
    const target = this.writer.resolvePath(collectionPath);
    try {
      const entries = await fs.readdir(target.absolutePath, { withFileTypes: true });
      const notes: Array<{ filePath: string; content: string }> = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const filePath = `${target.relativePath}/${entry.name}`;
        notes.push({ filePath, content: await fs.readFile(path.join(target.absolutePath, entry.name), 'utf8') });
      }
      return notes;
    } catch {
      return [];
    }
  }

  private async listCollections(): Promise<string[]> {
    if (!this.isReady() || !this.writer) return [];
    const target = this.writer.resolvePath(this.baseDir);
    try {
      const entries = await fs.readdir(target.absolutePath, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

function formatRecord(input: ObsidianRecordInput): string {
  const properties: Record<string, FrontmatterValue> = {
    title: input.title,
    aliases: [input.id, input.title],
    date: formatDate(input.createdAt),
    created: input.createdAt,
    updated: input.updatedAt,
    collection: input.collection,
    status: input.status,
    cssclasses: ['ide-database-record', `ide-${normalizeTag(input.collection)}`],
    ...(input.properties ?? {}),
  };

  return [
    '---',
    ...formatFrontmatter(properties, input.tags ?? []),
    '---',
    '',
    `# ${input.title}`,
    '',
    input.body,
    '',
    '## Related Notes',
    '',
    '- [[ai-first-ide|AI-first IDE]]',
    '- [[obsidian-vault-guide|Obsidian Vault Guide]]',
    '',
  ].join('\n');
}

function formatFrontmatter(properties: Record<string, FrontmatterValue>, tags: string[]): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlString(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }

  const normalizedTags = [...new Set(tags.map(normalizeTag).filter(Boolean))];
  if (normalizedTags.length) {
    lines.push('tags:');
    for (const tag of normalizedTags) {
      lines.push(`  - ${tag}`);
    }
  }
  return lines;
}

function formatToolApprovalBody(record: ToolApprovalRecord): string {
  return [
    '> [!info] Summary',
    `> ${quoteForCallout(record.summary)}`,
    '',
    '## Request',
    '',
    `- **Tool:** ${record.tool}`,
    `- **Action:** ${record.action}`,
    `- **Status:** ${record.status}`,
    record.cwd ? `- **CWD:** ${record.cwd}` : '- **CWD:** Not recorded',
    record.targetSessionId ? `- **Target session:** ${wikilink(record.targetSessionId)}` : '- **Target session:** Not recorded',
    '',
    '## Command',
    '',
    record.command ? fencedCode('bash', record.command) : 'No command recorded.',
    '',
    '## Decision',
    '',
    record.decidedAt ? `- **Decided at:** ${record.decidedAt}` : '- **Decided at:** Pending',
    record.reason ? `- **Reason:** ${record.reason}` : '- **Reason:** Not recorded',
    record.result?.sessionId ? `- **Result session:** ${wikilink(record.result.sessionId)}` : '- **Result:** Not recorded',
    '',
    '## Raw Record',
    '',
    fencedCode('json', JSON.stringify(record, null, 2)),
  ].join('\n');
}

function formatTaskStateBody(state: TaskState): string {
  return [
    '> [!note] Goal',
    `> ${quoteForCallout(state.goal || 'No goal recorded.')}`,
    '',
    '## Decisions',
    '',
    formatList(state.decisions),
    '',
    '## Constraints',
    '',
    formatList(state.constraints),
    '',
    '## Patch History',
    '',
    state.patches.length ? state.patches.map((patch) => `- **${patch.status}:** ${wikilink(patch.patchId, patch.title)} (${patch.filePath})`).join('\n') : 'No patches recorded.',
    '',
    '## Handoff Summary',
    '',
    state.lastHandoffSummary || 'No handoff summary recorded.',
    '',
    '## Memory Records',
    '',
    state.memory.length ? state.memory.map((record) => `- **${record.kind}:** ${wikilink(record.id, record.summary)}`).join('\n') : 'No memory records recorded.',
    '',
    '## Provider Usage',
    '',
    state.providerUsage.length ? state.providerUsage.map((usage) => `- **${usage.providerId}/${usage.modelId}:** ${usage.success ? 'success' : 'failed'} (${usage.chosenAs})`).join('\n') : 'No provider usage recorded.',
    '',
    '## Raw State',
    '',
    fencedCode('json', JSON.stringify(state, null, 2)),
  ].join('\n');
}

function formatPatchMemoryBody(sessionId: string, patch: PatchMemory): string {
  return [
    '> [!note] Summary',
    `> ${quoteForCallout(patch.summary)}`,
    '',
    '## Patch',
    '',
    `- **Session:** ${wikilink(sessionId)}`,
    `- **Patch ID:** ${patch.patchId}`,
    `- **Status:** ${patch.status}`,
    `- **File:** ${patch.filePath}`,
    `- **Timestamp:** ${patch.timestamp}`,
    '',
    '## Raw Patch Memory',
    '',
    fencedCode('json', JSON.stringify(patch, null, 2)),
  ].join('\n');
}

function formatMemoryRecordBody(record: MemoryRecord): string {
  return [
    '> [!note] Summary',
    `> ${quoteForCallout(record.summary)}`,
    '',
    '## Memory',
    '',
    `- **Session:** ${wikilink(record.sessionId)}`,
    `- **Kind:** ${record.kind}`,
    `- **Source:** ${record.source}`,
    `- **Timestamp:** ${record.timestamp}`,
    '',
    '## Detail',
    '',
    record.detail || 'No detail recorded.',
    '',
    '## Raw Memory Record',
    '',
    fencedCode('json', JSON.stringify(record, null, 2)),
  ].join('\n');
}

function formatTraceBody(trace: SessionTrace): string {
  return [
    '> [!info] Trace Summary',
    `> Session ${trace.sessionId} has ${trace.summary.totalSteps} recorded steps.`,
    '',
    '## Trace',
    '',
    `- **Session:** ${wikilink(trace.sessionId)}`,
    `- **Agent:** ${trace.agentId}`,
    `- **Started:** ${trace.startedAt}`,
    trace.endedAt ? `- **Ended:** ${trace.endedAt}` : '- **Ended:** Active',
    `- **Total steps:** ${trace.summary.totalSteps}`,
    `- **Tool calls:** ${trace.summary.toolCalls}`,
    `- **Errors:** ${trace.summary.errors}`,
    `- **Retries:** ${trace.summary.retries}`,
    '',
    '## Steps',
    '',
    trace.steps.length ? trace.steps.map((step) => `- **${step.type}:** ${step.agentId} at ${step.timestamp}`).join('\n') : 'No trace steps recorded.',
    '',
    '## Raw Trace',
    '',
    fencedCode('json', JSON.stringify(trace, null, 2)),
  ].join('\n');
}

function formatWorkflowRunBody(run: WorkflowRunState): string {
  return [
    '> [!info] Workflow Run Summary',
    `> Workflow ${run.workflowId} is ${run.status}.`,
    '',
    '## Run',
    '',
    `- **Run ID:** ${run.runId}`,
    `- **Workflow:** ${run.workflowId}`,
    `- **Collaboration:** ${run.collaborationId}`,
    `- **Status:** ${run.status}`,
    run.pausedAtNodeId ? `- **Paused at:** ${run.pausedAtNodeId}` : '- **Paused at:** Not paused',
    `- **Created:** ${run.createdAt}`,
    `- **Updated:** ${run.updatedAt}`,
    '',
    '## Nodes',
    '',
    run.nodeStates.length ? run.nodeStates.map((node) => `- **${node.status}:** ${node.nodeId}${node.error ? ` — ${node.error}` : ''}`).join('\n') : 'No nodes recorded.',
    '',
    '## Outputs',
    '',
    run.outputs.length ? run.outputs.map((output) => `- **${output.role}:** ${output.summary}`).join('\n') : 'No outputs recorded.',
    '',
    '## Raw Workflow Run',
    '',
    fencedCode('json', JSON.stringify(run, null, 2)),
  ].join('\n');
}

function formatList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : 'Nothing recorded.';
}

function fencedCode(language: string, content: string): string {
  const fence = content.includes('```') ? '````' : '```';
  return [`${fence}${language}`, content, fence].join('\n');
}

function quoteForCallout(value: string): string {
  return value.replace(/\n/g, '\n> ');
}

function yamlScalar(value: string | number | boolean): string {
  return typeof value === 'string' ? yamlString(value) : String(value);
}

function yamlString(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return /^[A-Za-z0-9_./-]+$/.test(normalized) ? normalized : JSON.stringify(normalized);
}

function formatDate(value: string | undefined): string | undefined {
  return value?.slice(0, 10);
}

function wikilink(note: string, label?: string): string {
  const target = slugify(note);
  const display = label?.trim();
  return display && display !== target ? `[[${target}|${display}]]` : `[[${target}]]`;
}

function normalizeBaseDir(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'docs/memory/database';
}

function normalizePathSegment(value: string): string {
  return value.trim().replace(/\\/g, '/').split('/').map(slugify).filter(Boolean).join('/');
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'record';
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#+/, '').replace(/[^a-zA-Z0-9_/-]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseJsonSection(content: string, heading: string): unknown {
  const headingIndex = content.indexOf(`## ${heading}`);
  if (headingIndex === -1) return undefined;
  const section = content.slice(headingIndex);
  const match = section.match(/`{3,4}json\s*([\s\S]*?)\s*`{3,4}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1] ?? '');
  } catch {
    return undefined;
  }
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const lines = content.slice(4, end).split('\n');
  const result: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    if (line.startsWith('  - ') && currentArrayKey) {
      const list = result[currentArrayKey];
      if (Array.isArray(list)) {
        list.push(parseYamlScalar(line.slice(4)));
      }
      continue;
    }

    currentArrayKey = null;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!key) continue;
    if (!rawValue) {
      result[key] = [];
      currentArrayKey = key;
      continue;
    }
    result[key] = parseYamlScalar(rawValue);
  }

  return result;
}

function parseYamlScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stringFromProperty(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isToolApprovalRecord(value: unknown): value is ToolApprovalRecord {
  const record = value as Partial<ToolApprovalRecord>;
  return !!record && typeof record === 'object'
    && typeof record.id === 'string'
    && typeof record.tool === 'string'
    && typeof record.action === 'string'
    && typeof record.status === 'string'
    && typeof record.summary === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string';
}

function isTaskState(value: unknown): value is TaskState {
  const state = value as Partial<TaskState>;
  return !!state && typeof state === 'object'
    && typeof state.sessionId === 'string'
    && typeof state.goal === 'string'
    && Array.isArray(state.decisions)
    && Array.isArray(state.constraints)
    && Array.isArray(state.patches)
    && Array.isArray(state.memory)
    && Array.isArray(state.providerUsage)
    && typeof state.createdAt === 'string'
    && typeof state.updatedAt === 'string';
}

function isSessionTrace(value: unknown): value is SessionTrace {
  const trace = value as Partial<SessionTrace>;
  return !!trace && typeof trace === 'object'
    && typeof trace.sessionId === 'string'
    && typeof trace.agentId === 'string'
    && typeof trace.startedAt === 'string'
    && Array.isArray(trace.steps)
    && !!trace.summary
    && typeof trace.summary === 'object';
}

function isWorkflowRunState(value: unknown): value is WorkflowRunState {
  const run = value as Partial<WorkflowRunState>;
  return !!run && typeof run === 'object'
    && typeof run.runId === 'string'
    && typeof run.workflowId === 'string'
    && typeof run.collaborationId === 'string'
    && typeof run.status === 'string'
    && Array.isArray(run.nodeStates)
    && Array.isArray(run.outputs)
    && typeof run.createdAt === 'string'
    && typeof run.updatedAt === 'string';
}
