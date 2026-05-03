import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolApprovalAction, ToolApprovalRecord, ToolApprovalStatus, ToolApprovalTool } from '@ide/protocol';

import type { ObsidianDatabaseService } from './obsidian-database';

export class ToolApprovalError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'TOOL_APPROVAL_ERROR',
  ) {
    super(message);
    this.name = 'ToolApprovalError';
  }
}

export interface ToolApprovalCreateInput {
  tool: ToolApprovalTool;
  action: ToolApprovalAction;
  summary: string;
  command?: string;
  cwd?: string;
  targetSessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolApprovalApproveInput {
  reason?: string;
  execute?: (approval: ToolApprovalRecord) => Promise<ToolApprovalRecord['result']>;
}

export class ToolApprovalStore {
  private readonly records = new Map<string, ToolApprovalRecord>();

  create(record: Omit<ToolApprovalRecord, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { id?: string }): ToolApprovalRecord {
    const now = new Date().toISOString();
    const next: ToolApprovalRecord = {
      ...record,
      id: record.id?.trim() || randomUUID(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(next.id, next);
    return next;
  }

  get(id: string): ToolApprovalRecord | null {
    return this.records.get(id) ?? null;
  }

  update(id: string, patch: Partial<Omit<ToolApprovalRecord, 'id' | 'createdAt'>>): ToolApprovalRecord | null {
    const current = this.records.get(id);
    if (!current) return null;
    const updated: ToolApprovalRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }

  list(status?: ToolApprovalStatus): ToolApprovalRecord[] {
    return [...this.records.values()]
      .filter((record) => !status || record.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  replaceAll(records: ToolApprovalRecord[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }
}

export class FileBackedToolApprovalStore extends ToolApprovalStore {
  constructor(private readonly persistence: { filePath?: string } = {}) {
    super();
  }

  async hydrate(): Promise<void> {
    if (!this.persistence.filePath) return;
    try {
      const raw = await fs.readFile(this.persistence.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { records?: ToolApprovalRecord[] };
      this.replaceAll(parsed.records ?? []);
    } catch {
      return;
    }
  }

  async persistNow(): Promise<void> {
    if (!this.persistence.filePath) return;
    await fs.mkdir(path.dirname(this.persistence.filePath), { recursive: true });
    await fs.writeFile(this.persistence.filePath, `${JSON.stringify({ records: this.list() }, null, 2)}\n`, 'utf8');
  }
}

export class ToolApprovalService {
  constructor(
    private readonly store: ToolApprovalStore = new ToolApprovalStore(),
    private readonly obsidianDb?: ObsidianDatabaseService,
  ) {}

  setWorkspaceRoot(rootDir: string): void {
    this.obsidianDb?.setWorkspaceRoot(rootDir);
  }

  async hydrateFromObsidian(): Promise<void> {
    if (!this.obsidianDb) return;
    const records = await this.obsidianDb.readToolApprovals();
    if (!records.length) return;
    const merged = new Map<string, ToolApprovalRecord>();
    for (const record of this.store.list()) {
      merged.set(record.id, record);
    }
    for (const record of records) {
      const existing = merged.get(record.id);
      if (!existing || record.updatedAt.localeCompare(existing.updatedAt) > 0) {
        merged.set(record.id, record);
      }
    }
    this.store.replaceAll([...merged.values()]);
    await this.persistStore();
  }

  list(status?: ToolApprovalStatus): ToolApprovalRecord[] {
    return this.store.list(status);
  }

  get(id: string): ToolApprovalRecord | null {
    return this.store.get(id);
  }

  async create(input: ToolApprovalCreateInput): Promise<ToolApprovalRecord> {
    const summary = input.summary.trim();
    if (!summary) {
      throw new ToolApprovalError('Approval summary is required');
    }
    const record = this.store.create({
      tool: input.tool,
      action: input.action,
      summary,
      command: normalizeOptionalString(input.command),
      cwd: normalizeOptionalString(input.cwd),
      targetSessionId: normalizeOptionalString(input.targetSessionId),
      metadata: input.metadata,
    });
    await this.persistStore();
    await this.mirrorApproval(record);
    return record;
  }

  async approve(id: string, input: ToolApprovalApproveInput = {}): Promise<ToolApprovalRecord | null> {
    const current = this.store.get(id);
    if (!current) return null;
    this.assertPending(current);
    const result = input.execute ? await input.execute(current) : undefined;
    const updated = this.store.update(id, {
      status: 'approved',
      decidedAt: new Date().toISOString(),
      reason: normalizeOptionalString(input.reason),
      result,
    });
    await this.persistStore();
    await this.mirrorApproval(updated);
    return updated;
  }

  async reject(id: string, reason?: string): Promise<ToolApprovalRecord | null> {
    const current = this.store.get(id);
    if (!current) return null;
    this.assertPending(current);
    const updated = this.store.update(id, {
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      reason: normalizeOptionalString(reason),
    });
    await this.persistStore();
    await this.mirrorApproval(updated);
    return updated;
  }

  async markExpired(id: string, reason?: string): Promise<ToolApprovalRecord | null> {
    const current = this.store.get(id);
    if (!current) return null;
    this.assertPending(current);
    const updated = this.store.update(id, {
      status: 'expired',
      decidedAt: new Date().toISOString(),
      reason: normalizeOptionalString(reason),
    });
    await this.persistStore();
    await this.mirrorApproval(updated);
    return updated;
  }

  private assertPending(record: ToolApprovalRecord): void {
    if (record.status !== 'pending') {
      throw new ToolApprovalError(`Approval ${record.id} is already ${record.status}`, 409, 'TOOL_APPROVAL_NOT_PENDING');
    }
  }

  private async persistStore(): Promise<void> {
    if ('persistNow' in this.store && typeof this.store.persistNow === 'function') {
      await this.store.persistNow();
    }
  }

  private async mirrorApproval(record: ToolApprovalRecord | null): Promise<void> {
    if (!record || !this.obsidianDb) return;
    try {
      await this.obsidianDb.writeToolApproval(record);
    } catch {}
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
