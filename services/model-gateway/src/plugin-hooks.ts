import type { AIRequest, AIResponse, GatewayPluginHook, PluginHookRegistry } from '@ide/protocol';
import { createHash } from 'crypto';
import os from 'os';

/**
 * DefaultPluginHookRegistry implements PluginHookRegistry
 * Manages multiple plugin hooks with sequential execution
 */
export class DefaultPluginHookRegistry implements PluginHookRegistry {
  private hooks: Map<string, GatewayPluginHook> = new Map();

  register(hook: GatewayPluginHook): void {
    this.hooks.set(hook.name, hook);
  }

  unregister(name: string): void {
    this.hooks.delete(name);
  }

  async beforeRequest(request: AIRequest): Promise<AIRequest> {
    let result = request;
    for (const hook of this.hooks.values()) {
      if (hook.beforeRequest) {
        result = await Promise.resolve(hook.beforeRequest(result));
      }
    }
    return result;
  }

  async afterResponse(response: AIResponse): Promise<AIResponse> {
    let result = response;
    for (const hook of this.hooks.values()) {
      if (hook.afterResponse) {
        result = await Promise.resolve(hook.afterResponse(result));
      }
    }
    return result;
  }

  listHooks(): string[] {
    return [...this.hooks.keys()];
  }
}

/**
 * CacheKeyPlugin implements OpenCode-style cache key stabilization
 * Generates stable SHA256 cache keys based on workspace identity
 */
export interface CacheKeyPluginOptions {
  /**
   * Override the cache key (highest priority)
   */
  cacheKeyOverride?: string;
  /**
   * Use workspace-based stable key generation
   * Format: user@host:<absolute_workspace_path>
   */
  useWorkspaceBasedKey?: boolean;
  /**
   * Workspace root for key generation
   */
  workspaceRoot?: string;
  /**
   * Additional entropy (e.g., user ID)
   */
  userId?: string;
}

/**
 * Create a CacheKeyPlugin that stabilizes cache keys
 * Inspired by opencode-context-cache
 */
export function createCacheKeyPlugin(options: CacheKeyPluginOptions): GatewayPluginHook {
  const name = 'cache-key-stabilization';

  // Generate stable cache key
  const cacheKey = generateStableCacheKey(options);

  return {
    name,
    beforeRequest(request) {
      return {
        ...request,
        context: {
          ...request.context,
          metadata: {
            ...request.context.metadata,
            promptCacheKey: cacheKey,
            sessionId: cacheKey, // Also use as session ID for consistency
          },
        },
      };
    },
  };
}

/**
 * Generate a stable cache key based on workspace identity
 * Uses SHA256 of user@host:workspace format (like OpenCode)
 */
function generateStableCacheKey(options: CacheKeyPluginOptions): string {
  // Priority 1: Manual override
  if (options.cacheKeyOverride) {
    return hashIfNeeded(options.cacheKeyOverride);
  }

  // Priority 2: Workspace-based key
  if (options.useWorkspaceBasedKey && options.workspaceRoot) {
    const user = options.userId ?? os.userInfo().username ?? 'user';
    const hostname = os.hostname?.() ?? 'localhost';
    const rawKey = `${user}@${hostname}:${options.workspaceRoot}`;
    return sha256(rawKey);
  }

  // Priority 3: Random fallback (not stable, but consistent per process)
  return sha256(`fallback-${Date.now()}-${Math.random()}`);
}

/**
 * SHA256 hash helper
 */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Only hash if not already a SHA256 hex string (detect existing hashes)
 */
function hashIfNeeded(input: string): string {
  const sha256Pattern = /^[a-f0-9]{64}$/i;
  if (sha256Pattern.test(input)) {
    return input; // Already a hash
  }
  return sha256(input);
}
