import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AuditLogEntry {
  timestamp: string;
  action: 'patch.create' | 'patch.approve' | 'patch.apply' | 'patch.rollback' | 'workspace.save' | 'terminal.exec';
  entityId: string;
  workspaceRoot?: string;
  actor?: string;
  details?: Record<string, unknown>;
}

interface AuditLogOptions {
  filePath?: string;
}

export class AuditLogService {
  private readonly entries: AuditLogEntry[] = [];

  constructor(private readonly options: AuditLogOptions = {}) {}

  async append(entry: Omit<AuditLogEntry, 'timestamp'>): Promise<void> {
    const next: AuditLogEntry = { ...entry, timestamp: new Date().toISOString() };
    this.entries.push(next);
    await this.persist();
  }

  list(): AuditLogEntry[] {
    return [...this.entries];
  }

  private async persist(): Promise<void> {
    if (!this.options.filePath) return;

    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    await fs.writeFile(this.options.filePath, `${JSON.stringify({ entries: this.entries }, null, 2)}\n`, 'utf8');
  }
}
