import type { ModelTier, ProviderHealth, ProviderId, RoutingStrategy } from './ai';

export type PrivacyMode = 'standard' | 'localOnly';
export type LocalProviderId = Extract<ProviderId, 'ollama' | 'vllm'>;

export interface LocalProviderSettings {
  providerId: LocalProviderId;
  enabled: boolean;
  baseUrl: string;
  models: string[];
  timeoutMs: number;
}

export interface PolicySettings {
  privacyMode: PrivacyMode;
  defaultStrategy: RoutingStrategy;
  allowCloudProviders: boolean;
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
  updatedAt: string;
}

export interface IDESettingsUpdate {
  policy?: Partial<PolicySettings>;
  localProviders?: LocalProviderSettings[];
  workspaceOverrides?: Record<string, WorkspaceSettingsOverride | null>;
  memory?: Partial<MemorySettings>;
  desktop?: Partial<DesktopShellSettings>;
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
