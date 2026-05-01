import type {
  MemoryRecord,
  PatchMemory,
  ProviderUsageOutcome,
  SessionMemoryStore,
  TaskState,
} from '@ide/protocol';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface SessionStoreOptions {
  persistenceFilePath?: string;
  persist?: boolean;
}

const MAX_DECISIONS = 50;
const MAX_CONSTRAINTS = 50;
const MAX_PATCHES = 30;
const MAX_MEMORY = 50;
const MAX_PROVIDER_USAGE = 100;
const MAX_TEXT_LENGTH = 8000;

export class InMemorySessionStore implements SessionMemoryStore {
  private readonly sessions = new Map<string, TaskState>();
  private loaded = false;

  constructor(private readonly options: SessionStoreOptions = {}) {}

  async getTaskState(sessionId: string): Promise<TaskState | null> {
    await this.load();
    return this.sessions.get(sessionId) ?? null;
  }

  async ensureTaskState(sessionId: string, goal: string): Promise<TaskState> {
    await this.load();
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const state: TaskState = {
      sessionId,
      goal: sanitizeText(goal),
      decisions: [],
      constraints: [],
      patches: [],
      memory: [],
      providerUsage: [],
      lastHandoffSummary: '',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, state);
    await this.persist();
    return state;
  }

  private touch(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.updatedAt = new Date().toISOString();
  }

  async addDecision(sessionId: string, decision: string): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.decisions.push(sanitizeText(decision));
    state.decisions.splice(0, Math.max(0, state.decisions.length - MAX_DECISIONS));
    this.touch(sessionId);
    await this.persist();
  }

  async addConstraint(sessionId: string, constraint: string): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.constraints.push(sanitizeText(constraint));
    state.constraints.splice(0, Math.max(0, state.constraints.length - MAX_CONSTRAINTS));
    this.touch(sessionId);
    await this.persist();
  }

  async addPatchRecord(sessionId: string, patch: PatchMemory): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const normalized = normalizePatch(patch);
    const existing = state.patches.findIndex((p) => p.patchId === normalized.patchId);
    if (existing !== -1) {
      state.patches[existing] = normalized;
    } else {
      state.patches.push(normalized);
    }
    state.patches.splice(0, Math.max(0, state.patches.length - MAX_PATCHES));
    this.touch(sessionId);
    await this.persist();
  }

  async addMemory(sessionId: string, record: MemoryRecord): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.memory.push(normalizeMemoryRecord(record));
    state.memory.splice(0, Math.max(0, state.memory.length - MAX_MEMORY));
    this.touch(sessionId);
    await this.persist();
  }

  async recordProviderUsage(
    sessionId: string,
    usage: ProviderUsageOutcome,
  ): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.providerUsage.push(normalizeProviderUsage(usage));
    state.providerUsage.splice(0, Math.max(0, state.providerUsage.length - MAX_PROVIDER_USAGE));
    this.touch(sessionId);
    await this.persist();
  }

  async updateHandoffSummary(sessionId: string, summary: string): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.lastHandoffSummary = sanitizeText(summary);
    this.touch(sessionId);
    await this.persist();
  }

  async getHandoffSummary(sessionId: string): Promise<string> {
    await this.load();
    return this.sessions.get(sessionId)?.lastHandoffSummary ?? '';
  }

  async listSessions(): Promise<string[]> {
    await this.load();
    return [...this.sessions.keys()];
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    if (!this.options.persist || !this.options.persistenceFilePath) {
      return;
    }

    try {
      const raw = await fs.readFile(this.options.persistenceFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { sessions?: TaskState[] };
      for (const session of parsed.sessions ?? []) {
        this.sessions.set(session.sessionId, normalizeTaskState(session));
      }
    } catch {}
  }

  private async persist(): Promise<void> {
    if (!this.options.persist || !this.options.persistenceFilePath) {
      return;
    }

    await fs.mkdir(path.dirname(this.options.persistenceFilePath), { recursive: true });
    await fs.writeFile(
      this.options.persistenceFilePath,
      `${JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2)}\n`,
      'utf8',
    );
  }
}

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
}

function normalizeMemoryRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    summary: sanitizeText(record.summary),
    detail: record.detail ? sanitizeText(record.detail) : undefined,
    source: sanitizeText(record.source),
    metadata: record.metadata,
  };
}

function normalizePatch(patch: PatchMemory): PatchMemory {
  return {
    ...patch,
    title: sanitizeText(patch.title),
    filePath: sanitizeText(patch.filePath),
    summary: sanitizeText(patch.summary),
  };
}

function normalizeProviderUsage(usage: ProviderUsageOutcome): ProviderUsageOutcome {
  return {
    ...usage,
    errorMessage: usage.errorMessage ? sanitizeText(usage.errorMessage) : undefined,
  };
}

function normalizeTaskState(state: TaskState): TaskState {
  return {
    ...state,
    goal: sanitizeText(state.goal),
    decisions: state.decisions.map(sanitizeText).slice(-MAX_DECISIONS),
    constraints: state.constraints.map(sanitizeText).slice(-MAX_CONSTRAINTS),
    patches: state.patches.map(normalizePatch).slice(-MAX_PATCHES),
    memory: state.memory.map(normalizeMemoryRecord).slice(-MAX_MEMORY),
    providerUsage: state.providerUsage.map(normalizeProviderUsage).slice(-MAX_PROVIDER_USAGE),
    lastHandoffSummary: sanitizeText(state.lastHandoffSummary),
  };
}
