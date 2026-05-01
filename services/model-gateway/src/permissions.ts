import type {
  AgentPermissionSettings,
  PermissionLevel,
  ToolPermissionConfig,
} from '@ide/protocol';

export interface PermissionCheckResult {
  allowed: boolean;
  requiresAsk: boolean;
  denied: boolean;
  reason?: string;
}

/**
 * PermissionService implements the OpenCode-style permission system
 * with ask/allow/deny levels and pattern matching for tools like bash
 */
export class PermissionService {
  private permissions: AgentPermissionSettings;

  constructor(permissions: AgentPermissionSettings = {}) {
    this.permissions = permissions;
  }

  /**
   * Update the permission configuration
   */
  updatePermissions(permissions: AgentPermissionSettings): void {
    this.permissions = permissions;
  }

  /**
   * Check if a simple tool (without arguments) is allowed
   */
  checkTool(toolName: keyof AgentPermissionSettings): PermissionCheckResult {
    const level = this.permissions[toolName] ?? 'ask';
    // If it's a pattern-based config (object), treat as ask
    if (typeof level === 'object') {
      return { allowed: false, requiresAsk: true, denied: false };
    }
    return this.evaluateLevel(level);
  }

  /**
   * Check if a tool with arguments (like bash) is allowed
   * Supports pattern matching similar to OpenCode
   * 
   * Examples:
   * - bash: "ask" -> all commands require ask
   * - bash: { "git status": "allow", "*": "ask" } -> git status allowed, others ask
   * - bash: { "rm *": "deny" } -> rm commands denied
   */
  checkToolWithArgs(
    toolName: 'bash' | 'task' | 'externalDirectory',
    args: string,
  ): PermissionCheckResult {
    const config = this.permissions[toolName];

    // Simple permission level (string)
    if (typeof config === 'string') {
      return this.evaluateLevel(config);
    }

    // Pattern-based config
    if (typeof config === 'object' && config !== null) {
      return this.matchPatternConfig(config, args);
    }

    // Default: ask
    return { allowed: false, requiresAsk: true, denied: false };
  }

  /**
   * Check edit permission (convenience method)
   */
  canEdit(): PermissionCheckResult {
    return this.checkTool('edit');
  }

  /**
   * Check bash permission with command
   */
  canBash(command: string): PermissionCheckResult {
    return this.checkToolWithArgs('bash', command);
  }

  /**
   * Get effective permissions (merged with defaults)
   */
  getEffectivePermissions(): Required<AgentPermissionSettings> {
    return {
      read: this.permissions.read ?? 'allow',
      edit: this.permissions.edit ?? 'ask',
      write: this.permissions.write ?? 'ask',
      applyPatch: this.permissions.applyPatch ?? 'ask',
      glob: this.permissions.glob ?? 'allow',
      grep: this.permissions.grep ?? 'allow',
      list: this.permissions.list ?? 'allow',
      webfetch: this.permissions.webfetch ?? 'ask',
      websearch: this.permissions.websearch ?? 'ask',
      lsp: this.permissions.lsp ?? 'allow',
      skill: this.permissions.skill ?? 'allow',
      question: this.permissions.question ?? 'allow',
      todoread: this.permissions.todoread ?? 'allow',
      todowrite: this.permissions.todowrite ?? 'ask',
      bash: this.permissions.bash ?? 'ask',
      task: this.permissions.task ?? 'ask',
      externalDirectory: this.permissions.externalDirectory ?? 'ask',
    };
  }

  private evaluateLevel(level: PermissionLevel): PermissionCheckResult {
    switch (level) {
      case 'allow':
        return { allowed: true, requiresAsk: false, denied: false };
      case 'deny':
        return { allowed: false, requiresAsk: false, denied: true, reason: 'Tool is denied by policy' };
      case 'ask':
      default:
        return { allowed: false, requiresAsk: true, denied: false };
    }
  }

  /**
   * Match pattern-based config against arguments
   * Patterns are matched in order, last match wins (like OpenCode)
   */
  private matchPatternConfig(config: ToolPermissionConfig, args: string): PermissionCheckResult {
    const patterns = Object.entries(config);
    let result: PermissionCheckResult = { allowed: false, requiresAsk: true, denied: false };

    for (const [pattern, level] of patterns) {
      if (this.matchesPattern(pattern, args)) {
        result = this.evaluateLevel(level);
      }
    }

    return result;
  }

  /**
   * Check if args matches pattern
   * Supports: exact match, * wildcard (any chars), ? single char
   */
  private matchesPattern(pattern: string, args: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*/g, '.*') // * matches any chars
      .replace(/\?/g, '.'); // ? matches single char

    const regex = new RegExp(`^(?:${regexPattern})$`, 'i');
    return regex.test(args);
  }
}

/**
 * Create a restrictive permission set (like OpenCode's 'plan' agent)
 */
export function createReadOnlyPermissions(): AgentPermissionSettings {
  return {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
    lsp: 'allow',
    skill: 'allow',
    question: 'allow',
    todoread: 'allow',
    edit: 'deny',
    write: 'deny',
    applyPatch: 'deny',
    todowrite: 'deny',
    bash: 'deny',
    task: 'deny',
    externalDirectory: 'deny',
  };
}

/**
 * Create a full-access permission set (like OpenCode's 'build' agent)
 */
export function createFullAccessPermissions(): AgentPermissionSettings {
  return {
    read: 'allow',
    edit: 'allow',
    write: 'allow',
    applyPatch: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
    lsp: 'allow',
    skill: 'allow',
    question: 'allow',
    todoread: 'allow',
    todowrite: 'allow',
    bash: { '*': 'allow' },
    task: { '*': 'allow' },
    externalDirectory: { '*': 'allow' },
  };
}
