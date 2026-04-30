import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  AIToolCall,
  MemoryRecord,
  PatchCreateRequest,
  PatchDiffLine,
  PatchMemory,
  PatchOperation,
  PatchOperationKind,
  PatchRecord,
  PatchReviewFinding,
  PatchReviewResult,
  PatchRollbackEntry,
  PatchStatus,
  SessionMemoryStore,
  StructuredPatchDiff,
} from '@ide/protocol';
import { AI_PATCH_TOOL_NAME } from '@ide/protocol';

import { WorkspacePathError, WorkspaceWriter } from './workspace-writer';

export class PatchServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'PATCH_ERROR',
  ) {
    super(message);
    this.name = 'PatchServiceError';
  }
}

export class PatchStore {
  private readonly records = new Map<string, PatchRecord>();

  create(record: Omit<PatchRecord, 'createdAt' | 'updatedAt'>): PatchRecord {
    const now = new Date().toISOString();
    const next: PatchRecord = { ...record, createdAt: now, updatedAt: now };
    this.records.set(record.id, next);
    return next;
  }

  get(id: string): PatchRecord | null {
    return this.records.get(id) ?? null;
  }

  update(id: string, patch: Partial<Omit<PatchRecord, 'id' | 'createdAt'>>): PatchRecord | null {
    const current = this.records.get(id);
    if (!current) return null;
    const updated: PatchRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  list(): PatchRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  replaceAll(records: PatchRecord[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }
}

interface PatchStorePersistence {
  filePath?: string;
}

export class FileBackedPatchStore extends PatchStore {
  constructor(private readonly persistence: PatchStorePersistence = {}) {
    super();
  }

  override create(record: Omit<PatchRecord, 'createdAt' | 'updatedAt'>): PatchRecord {
    const created = super.create(record);
    void this.persist();
    return created;
  }

  override update(id: string, patch: Partial<Omit<PatchRecord, 'id' | 'createdAt'>>): PatchRecord | null {
    const updated = super.update(id, patch);
    void this.persist();
    return updated;
  }

  override list(): PatchRecord[] {
    return super.list();
  }

  async hydrate(): Promise<void> {
    if (!this.persistence.filePath) return;
    try {
      const raw = await fs.readFile(this.persistence.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { records?: PatchRecord[] };
      super.replaceAll(parsed.records ?? []);
    } catch {
      return;
    }
  }

  private async persist(): Promise<void> {
    if (!this.persistence.filePath) return;
    await fs.mkdir(path.dirname(this.persistence.filePath), { recursive: true });
    await fs.writeFile(this.persistence.filePath, `${JSON.stringify({ records: this.list() }, null, 2)}\n`, 'utf8');
  }
}

export class PatchService {
  constructor(
    private readonly store: PatchStore = new PatchStore(),
    private readonly writer = new WorkspaceWriter(),
    private readonly sessionStore?: SessionMemoryStore,
  ) {}

  setWorkspaceRoot(rootDir: string): void {
    this.writer.setWorkspaceRoot(rootDir);
  }

  list(): PatchRecord[] {
    return this.store.list();
  }

  get(id: string): PatchRecord | null {
    return this.store.get(id);
  }

  async create(input: PatchCreateRequest): Promise<PatchRecord> {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new PatchServiceError('Patch requires title');

    const operations = this.normalizeOperations(input.operations);
    const diff = await this.buildDiff(operations);
    const review = await this.reviewOperations(operations);
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
    const patch = this.store.create({
      id: id || randomUUID(),
      title,
      summary: summary || 'AI proposed a code edit that can be reviewed before apply.',
      sessionId,
      status: 'pending',
      operations,
      diff,
      review,
      rollback: { available: false, entries: [] },
      notes: review.findings.map(formatReviewFinding),
    });

    await this.recordPatchMemory(patch, 'created');
    return patch;
  }

  async createFromToolCall(input: { toolCall: AIToolCall; sessionId?: string; fallbackFilePath?: string }): Promise<PatchRecord> {
    if (input.toolCall.name !== AI_PATCH_TOOL_NAME) {
      throw new PatchServiceError(`Unsupported patch tool call: ${input.toolCall.name}`);
    }
    const args = input.toolCall.arguments;
    const operations = Array.isArray(args.operations)
      ? args.operations
      : [{ id: 'op-1', kind: 'write_file', filePath: stringFromUnknown(args.filePath) ?? stringFromUnknown(args.path) ?? input.fallbackFilePath, beforeContent: stringFromUnknown(args.beforeContent), afterContent: stringFromUnknown(args.afterContent) ?? stringFromUnknown(args.content) ?? stringFromUnknown(args.newContent) }];
    return this.create({ id: input.toolCall.id, title: stringFromUnknown(args.title) ?? 'AI patch proposal', summary: stringFromUnknown(args.summary), sessionId: input.sessionId, operations: operations as PatchOperation[] });
  }

  async approve(id: string): Promise<PatchRecord | null> {
    const current = this.store.get(id);
    if (!current) return null;
    const review = await this.reviewOperations(current.operations);
    const reviewNotes = review.findings.map(formatReviewFinding);
    if (review.status === 'blocked') {
      const updated = this.store.update(id, { review, notes: ['Patch approval blocked by verifier checks', ...reviewNotes] });
      if (updated) await this.recordPatchMemory(updated, 'review_blocked');
      throw new PatchServiceError('Patch approval blocked by verifier checks', 409, 'PATCH_REVIEW_BLOCKED');
    }
    return this.updateStatus(id, 'approved', ['Patch approved for apply', ...reviewNotes], review);
  }

  async review(id: string): Promise<PatchRecord | null> {
    const current = this.store.get(id);
    if (!current) return null;
    const review = await this.reviewOperations(current.operations);
    const updated = this.store.update(id, { review, notes: review.findings.map(formatReviewFinding) });
    if (updated) await this.recordPatchMemory(updated, 'reviewed');
    return updated;
  }

  async reject(id: string): Promise<PatchRecord | null> {
    return this.updateStatus(id, 'rejected', ['Patch rejected']);
  }

  async apply(id: string): Promise<PatchRecord | null> {
    const current = this.store.get(id);
    if (!current) return null;
    if (current.status !== 'approved') {
      throw new PatchServiceError('Patch must be approved before apply', 409, 'PATCH_NOT_APPROVED');
    }
    const rollbackEntries: PatchRollbackEntry[] = [];
    const appliedAt = new Date().toISOString();
    try {
      for (const operation of current.operations) {
        const previousContent = await this.writer.readFile(operation.filePath);
        this.assertPrecondition(operation, previousContent);
        if (operation.kind === 'write_file') {
          if (operation.afterContent === undefined) throw new PatchServiceError('write_file operation requires afterContent');
          await this.writer.writeFile(operation.filePath, operation.afterContent);
          rollbackEntries.push({ filePath: operation.filePath, previousContent, appliedContent: operation.afterContent, appliedAt });
          continue;
        }
        await this.writer.deleteFile(operation.filePath);
        rollbackEntries.push({ filePath: operation.filePath, previousContent, appliedContent: null, appliedAt });
      }
    } catch (err) {
      await this.rollbackEntries(rollbackEntries);
      const failed = await this.updateStatus(id, 'failed', [`Apply failed: ${errorMessage(err)}`, 'Any partial writes were rolled back automatically']);
      if (failed) {
        throw new PatchServiceError(failed.notes?.[0] ?? 'Patch apply failed', err instanceof PatchServiceError ? err.statusCode : 400, err instanceof PatchServiceError ? err.code : 'PATCH_APPLY_FAILED');
      }
      throw err;
    }
    const applied = this.store.update(id, { status: 'applied', rollback: { available: true, entries: rollbackEntries }, notes: ['Patch applied successfully'] });
    if (applied) await this.recordPatchMemory(applied, 'applied');
    return applied;
  }

  async rollback(id: string): Promise<PatchRecord | null> {
    const current = this.store.get(id);
    if (!current) return null;
    if (current.status !== 'applied' || !current.rollback?.available) {
      throw new PatchServiceError('Patch does not have an available rollback plan', 409, 'PATCH_ROLLBACK_UNAVAILABLE');
    }
    await this.rollbackEntries(current.rollback.entries);
    const rolledBack = this.store.update(id, { status: 'rolled_back', rollback: { ...current.rollback, available: false, rolledBackAt: new Date().toISOString() }, notes: ['Patch rolled back successfully'] });
    if (rolledBack) await this.recordPatchMemory(rolledBack, 'rolled_back');
    return rolledBack;
  }

  private async updateStatus(id: string, status: PatchStatus, notes?: string[], review?: PatchReviewResult): Promise<PatchRecord | null> {
    const patch: Partial<Omit<PatchRecord, 'id' | 'createdAt'>> = { status, notes };
    if (review) patch.review = review;
    const updated = this.store.update(id, patch);
    if (updated) await this.recordPatchMemory(updated, status);
    return updated;
  }

  private async reviewOperations(operations: PatchOperation[]): Promise<PatchReviewResult> {
    const findings: PatchReviewFinding[] = [];
    for (const operation of operations) {
      let currentContent: string | null;
      try {
        currentContent = await this.writer.readFile(operation.filePath);
      } catch (err) {
        findings.push({ severity: 'error', code: err instanceof WorkspacePathError ? err.code : 'PATCH_FILE_READ_FAILED', message: err instanceof Error ? err.message : String(err), filePath: operation.filePath, operationId: operation.id });
        continue;
      }
      if (operation.beforeContent !== undefined && (currentContent ?? '') !== operation.beforeContent) {
        findings.push({ severity: 'error', code: 'PATCH_PRECONDITION_FAILED', message: `Current file content does not match beforeContent for ${operation.filePath}`, filePath: operation.filePath, operationId: operation.id });
        continue;
      }
      if (operation.beforeContent === undefined && currentContent !== null) {
        findings.push({ severity: 'warning', code: 'PATCH_PRECONDITION_MISSING', message: `Patch can be reviewed, but ${operation.filePath} has no beforeContent precondition.`, filePath: operation.filePath, operationId: operation.id });
      }
      if (operation.kind === 'write_file' && currentContent !== null && operation.afterContent === currentContent) {
        findings.push({ severity: 'warning', code: 'PATCH_NOOP_WRITE', message: `write_file does not change ${operation.filePath}.`, filePath: operation.filePath, operationId: operation.id });
      }
      if (operation.kind === 'delete_file' && currentContent === null) {
        findings.push({ severity: 'warning', code: 'PATCH_DELETE_MISSING_FILE', message: `delete_file target does not exist: ${operation.filePath}.`, filePath: operation.filePath, operationId: operation.id });
      }
    }
    const status = findings.some((finding) => finding.severity === 'error') ? 'blocked' : findings.length > 0 ? 'warning' : 'passed';
    return { status, reviewer: 'deterministic', verifier: 'precondition-check', findings, checkedAt: new Date().toISOString() };
  }

  private normalizeOperations(operations: PatchOperation[]): PatchOperation[] {
    if (!Array.isArray(operations) || operations.length === 0) throw new PatchServiceError('Patch requires at least one operation');
    return operations.map((operation, index) => {
      if (!operation || typeof operation !== 'object') throw new PatchServiceError('Patch operation must be an object');
      const kind = operation.kind;
      if (!isPatchOperationKind(kind)) throw new PatchServiceError(`Unsupported patch operation kind: ${String(kind)}`);
      if (typeof operation.filePath !== 'string') throw new PatchServiceError('Patch operation requires filePath');
      const filePath = operation.filePath.trim();
      if (!filePath) throw new PatchServiceError('Patch operation requires filePath');
      if (operation.beforeContent !== undefined && typeof operation.beforeContent !== 'string') throw new PatchServiceError('beforeContent must be a string when provided');
      if (kind === 'write_file' && typeof operation.afterContent !== 'string') throw new PatchServiceError('write_file operation requires afterContent');
      if (kind === 'delete_file' && operation.afterContent !== undefined && typeof operation.afterContent !== 'string') throw new PatchServiceError('afterContent must be a string when provided');
      return { ...operation, id: operation.id?.trim() || `op-${index + 1}`, kind, filePath };
    });
  }

  private async buildDiff(operations: PatchOperation[]): Promise<StructuredPatchDiff[]> {
    const diffs: StructuredPatchDiff[] = [];
    for (const operation of operations) {
      const previousContent = operation.beforeContent ?? (await this.writer.readFile(operation.filePath)) ?? '';
      const nextContent = operation.kind === 'delete_file' ? '' : operation.afterContent ?? '';
      diffs.push(buildStructuredDiff(operation.filePath, operation.kind, previousContent, nextContent));
    }
    return diffs;
  }

  private assertPrecondition(operation: PatchOperation, previousContent: string | null): void {
    if (operation.beforeContent === undefined) return;
    if ((previousContent ?? '') !== operation.beforeContent) {
      throw new PatchServiceError(`Patch precondition failed for ${operation.filePath}`, 409, 'PATCH_PRECONDITION_FAILED');
    }
  }

  private async rollbackEntries(entries: PatchRollbackEntry[]): Promise<void> {
    for (const entry of [...entries].reverse()) {
      if (entry.previousContent === null) {
        await this.writer.deleteFile(entry.filePath);
      } else {
        await this.writer.writeFile(entry.filePath, entry.previousContent);
      }
    }
  }

  private async recordPatchMemory(patch: PatchRecord, outcome: string): Promise<void> {
    if (!patch.sessionId || !this.sessionStore) return;
    const firstFilePath = patch.operations[0]?.filePath ?? 'unknown';
    const patchMemory: PatchMemory = { patchId: patch.id, title: patch.title, filePath: firstFilePath, status: patch.status, summary: patch.summary, timestamp: patch.updatedAt };
    await this.sessionStore.ensureTaskState(patch.sessionId, patch.summary);
    await this.sessionStore.addPatchRecord(patch.sessionId, patchMemory);
    const memoryRecord: MemoryRecord = { id: `${patch.id}:${patch.status}:${patch.updatedAt}`, sessionId: patch.sessionId, kind: 'patch', summary: `${patch.title} ${outcome}`, detail: patch.summary, source: 'model-gateway.patch-service', timestamp: patch.updatedAt, metadata: { patchId: patch.id, status: patch.status, files: patch.operations.map((operation) => operation.filePath) } };
    await this.sessionStore.addMemory(patch.sessionId, memoryRecord);
  }
}

function buildStructuredDiff(filePath: string, operation: PatchOperationKind, previousContent: string, nextContent: string): StructuredPatchDiff {
  const previousLines = splitLines(previousContent);
  const nextLines = splitLines(nextContent);
  let prefix = 0;
  while (prefix < previousLines.length && prefix < nextLines.length && previousLines[prefix] === nextLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousLines.length - prefix && suffix < nextLines.length - prefix && previousLines[previousLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]) suffix += 1;
  const contextBeforeStart = Math.max(0, prefix - 3);
  const previousChangeEnd = previousLines.length - suffix;
  const nextChangeEnd = nextLines.length - suffix;
  const contextAfterEnd = Math.min(previousLines.length, previousChangeEnd + 3);
  const removedCount = previousChangeEnd - prefix;
  const addedCount = nextChangeEnd - prefix;
  const leadingContext = prefix - contextBeforeStart;
  const trailingContext = contextAfterEnd - previousChangeEnd;
  const lines: PatchDiffLine[] = [];
  for (let index = contextBeforeStart; index < prefix; index += 1) lines.push({ type: 'context', text: previousLines[index], oldLine: index + 1, newLine: index + 1 });
  for (let index = prefix; index < previousChangeEnd; index += 1) lines.push({ type: 'remove', text: previousLines[index], oldLine: index + 1 });
  for (let index = prefix; index < nextChangeEnd; index += 1) lines.push({ type: 'add', text: nextLines[index], newLine: index + 1 });
  for (let index = previousChangeEnd; index < contextAfterEnd; index += 1) {
    const nextLine = index + nextLines.length - previousLines.length;
    lines.push({ type: 'context', text: previousLines[index], oldLine: index + 1, newLine: nextLine + 1 });
  }
  const oldStart = Math.max(1, contextBeforeStart + 1);
  const newStart = Math.max(1, contextBeforeStart + 1);
  const oldCount = Math.max(0, leadingContext + removedCount + trailingContext);
  const newCount = Math.max(0, leadingContext + addedCount + trailingContext);
  return { filePath, operation, additions: addedCount, deletions: removedCount, hunks: [{ header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, lines }] };
}

function splitLines(content: string): string[] {
  if (!content) return [];
  return content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

function isPatchOperationKind(kind: unknown): kind is PatchOperationKind {
  return kind === 'write_file' || kind === 'delete_file';
}

function formatReviewFinding(finding: PatchReviewFinding): string {
  const target = finding.filePath ? ` (${finding.filePath})` : '';
  return `${finding.severity.toUpperCase()} ${finding.code}${target}: ${finding.message}`;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof WorkspacePathError || err instanceof PatchServiceError || err instanceof Error) return err.message;
  return String(err);
}
