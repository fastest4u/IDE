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
      goal,
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
    state.decisions.push(decision);
    this.touch(sessionId);
    await this.persist();
  }

  async addConstraint(sessionId: string, constraint: string): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.constraints.push(constraint);
    this.touch(sessionId);
    await this.persist();
  }

  async addPatchRecord(sessionId: string, patch: PatchMemory): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const existing = state.patches.findIndex((p) => p.patchId === patch.patchId);
    if (existing !== -1) {
      state.patches[existing] = patch;
    } else {
      state.patches.push(patch);
    }
    this.touch(sessionId);
    await this.persist();
  }

  async addMemory(sessionId: string, record: MemoryRecord): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.memory.push(record);
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
    state.providerUsage.push(usage);
    this.touch(sessionId);
    await this.persist();
  }

  async updateHandoffSummary(sessionId: string, summary: string): Promise<void> {
    await this.load();
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.lastHandoffSummary = summary;
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
        this.sessions.set(session.sessionId, session);
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
