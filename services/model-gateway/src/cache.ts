export type CacheScope = 'global' | 'workspace' | 'session' | 'request';

type CacheNamespace = string;

interface CacheEntry<T> {
  value: T;
  expiresAt?: number;
  scope: CacheScope;
  namespace: CacheNamespace;
  scopeId?: string;
}

export interface StableCacheOptions {
  defaultTtlMs?: number;
  maxEntries?: number;
}

export interface CacheContext {
  scope?: CacheScope;
  scopeId?: string;
}

export interface CacheGetOrBuildOptions extends CacheContext {
  ttlMs?: number;
}

export class StableMemoryCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly options: StableCacheOptions = {}) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (typeof entry.expiresAt === 'number' && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, scope: CacheScope = 'global', ttlMs = this.options.defaultTtlMs, namespace = 'default', scopeId?: string): void {
    this.entries.set(key, {
      value,
      scope,
      namespace,
      scopeId,
      expiresAt: typeof ttlMs === 'number' ? Date.now() + ttlMs : undefined,
    });
    this.evictIfNeeded();
  }

  getOrSet(key: string, factory: () => T, scope: CacheScope = 'global', ttlMs = this.options.defaultTtlMs, namespace = 'default', scopeId?: string): T {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const value = factory();
    this.set(key, value, scope, ttlMs, namespace, scopeId);
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(scope?: CacheScope): void {
    if (!scope) {
      this.entries.clear();
      return;
    }

    for (const [key, entry] of this.entries) {
      if (entry.scope === scope) {
        this.entries.delete(key);
      }
    }
  }

  invalidate(namespace?: CacheNamespace, scope?: CacheScope, scopeId?: string): void {
    for (const [key, entry] of this.entries) {
      if (namespace && entry.namespace !== namespace) continue;
      if (scope && entry.scope !== scope) continue;
      if (scopeId && entry.scopeId !== scopeId) continue;
      this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    const maxEntries = this.options.maxEntries;
    if (!maxEntries || this.entries.size <= maxEntries) return;
    const oldestKey = this.entries.keys().next().value as string | undefined;
    if (oldestKey) this.entries.delete(oldestKey);
  }
}
