import type { ModelTier, ProviderHealth, ProviderId, RoutingStrategy } from './ai';

export type PrivacyMode = 'standard' | 'localOnly';
export type LocalProviderId = Extract<ProviderId, 'opencode-go' | 'custom'>;

// Agent Permission Types (inspired by OpenCode)
export type PermissionLevel = 'ask' | 'allow' | 'deny';

export interface ToolPermissionConfig {
  // For tools with arguments (like bash), can specify patterns
  // e.g., "git *": "ask" means all git commands require ask
  // e.g., "git status": "allow" means git status is allowed without ask
  [pattern: string]: PermissionLevel;
}

export interface AgentPermissionSettings {
  // Simple tools (no arguments)
  read?: PermissionLevel;
  edit?: PermissionLevel;
  write?: PermissionLevel;
  applyPatch?: PermissionLevel;
  glob?: PermissionLevel;
  grep?: PermissionLevel;
  list?: PermissionLevel;
  webfetch?: PermissionLevel;
  websearch?: PermissionLevel;
  lsp?: PermissionLevel;
  skill?: PermissionLevel;
  question?: PermissionLevel;
  todoread?: PermissionLevel;
  todowrite?: PermissionLevel;
  // Tools with arguments (use pattern matching)
  bash?: ToolPermissionConfig | PermissionLevel;
  task?: ToolPermissionConfig | PermissionLevel;
  externalDirectory?: ToolPermissionConfig | PermissionLevel;
}

export interface LocalProviderSettings {
  providerId: LocalProviderId;
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: string[];
  timeoutMs: number;
}

export interface PolicySettings {
  privacyMode: PrivacyMode;
  defaultStrategy: RoutingStrategy;
  allowCloudProviders: boolean;
  // Global agent permissions (can be overridden per-agent)
  permissions?: AgentPermissionSettings;
}

// Agent configuration for custom agents (inspired by OpenCode)
export interface AgentConfig {
  id: string;
  name?: string;
  description?: string;
  mode: 'primary' | 'subagent' | 'hidden';
  model?: string; // provider/modelId format
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  permissions?: AgentPermissionSettings;
  // If true, agent can be switched to via UI
  selectable?: boolean;
}

export interface WorkspaceSettingsOverride {
  workspaceId: string;
  policy?: Partial<PolicySettings>;
  localProviderIds?: LocalProviderId[];
  updatedAt: string;
}

export interface MemorySettings {
  localFirst: boolean;
  persistSessionMemory: boolean;
  dataDir: string;
}

export interface DesktopShellSettings {
  reuseWebShell: boolean;
  webEntrypoint: string;
  gatewayUrl: string;
}

export interface IDESettings {
  version: 1;
  policy: PolicySettings;
  localProviders: LocalProviderSettings[];
  workspaceOverrides: Record<string, WorkspaceSettingsOverride>;
  memory: MemorySettings;
  desktop: DesktopShellSettings;
  // OpenCode-style custom agents
  agents?: Record<string, AgentConfig>;
  updatedAt: string;
}

export interface IDESettingsUpdate {
  policy?: Partial<PolicySettings>;
  localProviders?: LocalProviderSettings[];
  workspaceOverrides?: Record<string, WorkspaceSettingsOverride | null>;
  memory?: Partial<MemorySettings>;
  desktop?: Partial<DesktopShellSettings>;
  agents?: Record<string, AgentConfig>;
}

export interface EffectiveIDESettings {
  policy: PolicySettings;
  localProviderIds?: LocalProviderId[];
}

export interface ProviderRuntimeModelStatus {
  providerId: ProviderId;
  modelId: string;
  displayName: string;
  tier: ModelTier;
  capabilities: string[];
}

export interface ProviderRuntimeStatus extends ProviderHealth {
  registered: boolean;
  enabled: boolean;
  modelIds: string[];
  models: ProviderRuntimeModelStatus[];
}

export interface ProviderRuntimeStatusResponse {
  providers: ProviderRuntimeStatus[];
  localOnlyReady: boolean;
  checkedAt: string;
}

export interface ProviderTestConnectionResponse {
  provider: ProviderRuntimeStatus;
  ok: boolean;
  checkedAt: string;
}

export interface LocalProviderModelDefaults {
  providerId: LocalProviderId;
  displayName: string;
  tier: ModelTier;
  models: string[];
}
