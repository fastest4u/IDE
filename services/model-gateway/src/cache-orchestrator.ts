import { createStableCacheKey, type CacheKeyInput } from './cache-key';
import {
  StableMemoryCache,
  type CacheContext,
  type CacheGetOrBuildOptions,
  type CacheScope,
} from './cache';

export type CacheNamespace =
  | 'context-packet'
  | 'workspace-summary'
  | 'patch-review'
  | 'provider-status'
  | 'session-snapshot'
  | 'default';

export interface CacheBuildRequest extends CacheKeyInput {
  scope: CacheScope;
  scopeId?: string;
  ttlMs?: number;
}

export interface CacheEvent {
  type:
    | 'settings.updated'
    | 'workspace.root.changed'
    | 'workspace.file.changed'
    | 'session.memory.changed'
    | 'patch.changed'
    | 'provider.status.changed';
  namespace?: CacheNamespace;
  scope?: CacheContext['scope'];
  scopeId?: string;
}

export interface CacheEntryMeta {
  namespace: CacheNamespace;
  scope: CacheScope;
  scopeId?: string;
  ttlMs?: number;
}

export class CacheOrchestrator {
  constructor(
    private readonly cache = new StableMemoryCache<unknown>({ defaultTtlMs: 60_000, maxEntries: 512 }),
  ) {}

  get<T>(request: CacheBuildRequest): T | undefined {
    const key = createStableCacheKey(request);
    return this.cache.get(key) as T | undefined;
  }

  set<T>(request: CacheBuildRequest, value: T): void {
    const key = createStableCacheKey(request);
    this.cache.set(key, value, request.scope, request.ttlMs, request.namespace, request.scopeId);
  }

  async getOrBuild<T>(request: CacheBuildRequest, builder: () => Promise<T> | T): Promise<T> {
    const key = createStableCacheKey(request);
    const cached = this.cache.get(key) as T | undefined;
    if (cached !== undefined) return cached;

    const value = await builder();
    this.cache.set(key, value, request.scope, request.ttlMs, request.namespace, request.scopeId);
    return value;
  }

  invalidate(event: CacheEvent): void {
    switch (event.type) {
      case 'settings.updated': {
        this.cache.clear();
        return;
      }
      case 'workspace.root.changed': {
        this.invalidateMatching('context-packet', 'workspace', event.scopeId);
        this.invalidateMatching('workspace-summary', 'workspace', event.scopeId);
        this.invalidateMatching('patch-review', 'workspace', event.scopeId);
        this.invalidateMatching('session-snapshot', 'session', event.scopeId);
        return;
      }
      case 'workspace.file.changed': {
        this.invalidateMatching(event.namespace ?? 'context-packet', event.scope, event.scopeId);
        this.invalidateMatching('context-packet', 'workspace', event.scopeId);
        this.invalidateMatching('workspace-summary', 'workspace', event.scopeId);
        this.invalidateMatching('patch-review', 'workspace', event.scopeId);
        this.invalidateMatching('session-snapshot', 'session', event.scopeId);
        return;
      }
      case 'session.memory.changed': {
        this.invalidateMatching('context-packet', 'session', event.scopeId);
        this.invalidateMatching('session-snapshot', 'session', event.scopeId);
        return;
      }
      case 'patch.changed': {
        this.invalidateMatching('context-packet', 'session', event.scopeId);
        this.invalidateMatching('context-packet', 'workspace', event.scopeId);
        this.invalidateMatching('patch-review', event.scope, event.scopeId);
        this.invalidateMatching('session-snapshot', 'session', event.scopeId);
        return;
      }
      case 'provider.status.changed': {
        this.invalidateMatching('provider-status', event.scope, event.scopeId);
        return;
      }
    }
  }

  clear(scope?: CacheContext['scope']): void {
    this.cache.clear(scope);
  }

  size(): number {
    return this.cache.size();
  }

  private invalidateMatching(namespace: CacheNamespace, scope?: CacheContext['scope'], scopeId?: string): void {
    this.cache.invalidate(namespace, scope, scopeId);
  }
}
