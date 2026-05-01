import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type {
  EffectiveIDESettings,
  IDESettings,
  IDESettingsUpdate,
  LocalProviderSettings,
  LocalProviderId,
  ModelCapabilities,
  WorkspaceSettingsOverride,
} from '@ide/protocol';

import type { ProviderConnectionConfig } from './config/provider-config';

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.my-ide');
const SETTINGS_FILE_NAME = 'settings.json';

const LOCAL_CODE_CAPABILITIES: ModelCapabilities = {
  tools: true,
  vision: false,
  reasoning: true,
  streaming: true,
  longContext: true,
  codeEditing: true,
  embeddings: true,
  reranking: false,
};

export class LocalFirstSettingsService {
  private settings: IDESettings;

  constructor(
    private readonly dataDir = process.env.IDE_DATA_DIR ?? DEFAULT_DATA_DIR,
    private readonly settingsFilePath = path.join(dataDir, SETTINGS_FILE_NAME),
  ) {
    this.settings = this.loadSettings();
  }

  getSettings(): IDESettings {
    return structuredClone(this.settings);
  }

  updateSettings(update: IDESettingsUpdate): IDESettings {
    const next: IDESettings = {
      ...this.settings,
      policy: { ...this.settings.policy, ...update.policy },
      memory: { ...this.settings.memory, ...update.memory },
      desktop: { ...this.settings.desktop, ...update.desktop },
      localProviders: update.localProviders
        ? normalizeLocalProviders(update.localProviders)
        : this.settings.localProviders,
      workspaceOverrides: update.workspaceOverrides
        ? mergeWorkspaceOverrides(this.settings.workspaceOverrides, update.workspaceOverrides)
        : this.settings.workspaceOverrides,
      agents: update.agents
        ? { ...this.settings.agents, ...update.agents }
        : this.settings.agents,
      updatedAt: new Date().toISOString(),
    };

    this.settings = normalizeSettings(next, this.dataDir);
    this.persistSettings();
    return this.getSettings();
  }

  updateLocalProvider(provider: LocalProviderSettings): IDESettings {
    const existingProviders = this.settings.localProviders;
    const nextProviders = existingProviders.some((item) => item.providerId === provider.providerId)
      ? existingProviders.map((item) => (item.providerId === provider.providerId ? provider : item))
      : [...existingProviders, provider];

    return this.updateSettings({ localProviders: nextProviders });
  }

  restoreSettings(settings: IDESettings): IDESettings {
    this.settings = normalizeSettings(settings, this.dataDir);
    this.persistSettings();
    return this.getSettings();
  }

  getLocalProviderConfigs(): ProviderConnectionConfig[] {
    return this.settings.localProviders
      .filter((provider) => provider.enabled && provider.models.length > 0)
      .map(localProviderToConfig);
  }

  getLocalProviderConfig(providerId: LocalProviderSettings['providerId']): ProviderConnectionConfig | null {
    const provider = this.settings.localProviders.find((item) => item.providerId === providerId);
    if (!provider || provider.models.length === 0) {
      return null;
    }

    return localProviderToConfig(provider);
  }

  getEffectiveSettings(workspaceId?: string): EffectiveIDESettings {
    const override = workspaceId ? this.settings.workspaceOverrides[workspaceId] : undefined;
    return {
      policy: {
        ...this.settings.policy,
        ...override?.policy,
      },
      localProviderIds: override?.localProviderIds,
    };
  }

  getDataDir(): string {
    return this.settings.memory.dataDir;
  }

  isLocalOnly(workspaceId?: string): boolean {
    const policy = this.getEffectiveSettings(workspaceId).policy;
    return policy.privacyMode === 'localOnly' || !policy.allowCloudProviders;
  }

  hasAnyLocalOnlyPolicy(): boolean {
    if (this.isLocalOnly()) {
      return true;
    }

    return Object.values(this.settings.workspaceOverrides).some((override) => {
      const policy = { ...this.settings.policy, ...override.policy };
      return policy.privacyMode === 'localOnly' || !policy.allowCloudProviders;
    });
  }

  getLocalOnlyProviderScopes(): Array<LocalProviderSettings['providerId'][] | undefined> {
    const scopes: Array<LocalProviderSettings['providerId'][] | undefined> = [];
    if (this.isLocalOnly()) {
      scopes.push(undefined);
    }

    for (const override of Object.values(this.settings.workspaceOverrides)) {
      const policy = { ...this.settings.policy, ...override.policy };
      if (policy.privacyMode === 'localOnly' || !policy.allowCloudProviders) {
        scopes.push(override.localProviderIds);
      }
    }

    return scopes;
  }

  updateWorkspaceOverride(override: WorkspaceSettingsOverride | null): IDESettings {
    if (!override) {
      return this.updateSettings({ workspaceOverrides: {} });
    }

    const normalized = normalizeWorkspaceOverride(override);
    return this.updateSettings({
      workspaceOverrides: {
        [normalized.workspaceId]: normalized,
      },
    });
  }

  private loadSettings(): IDESettings {
    try {
      const raw = fs.readFileSync(this.settingsFilePath, 'utf8');
      return normalizeSettings(JSON.parse(raw) as Partial<IDESettings>, this.dataDir);
    } catch {
      const settings = defaultSettings(this.dataDir);
      this.settings = settings;
      this.persistSettings(settings);
      return settings;
    }
  }

  private persistSettings(settings: IDESettings = this.settings): void {
    fs.mkdirSync(path.dirname(this.settingsFilePath), { recursive: true });
    fs.writeFileSync(this.settingsFilePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

function defaultSettings(dataDir: string): IDESettings {
  const now = new Date().toISOString();
  return {
    version: 1,
    policy: {
      privacyMode: 'standard',
      defaultStrategy: 'primary',
      allowCloudProviders: true,
      permissions: {
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        lsp: 'allow',
        skill: 'allow',
        question: 'allow',
        todoread: 'allow',
        edit: 'ask',
        write: 'ask',
        applyPatch: 'ask',
        webfetch: 'ask',
        websearch: 'ask',
        todowrite: 'ask',
        bash: { '*': 'ask' },
        task: { '*': 'ask' },
        externalDirectory: { '*': 'ask' },
      },
    },
    localProviders: normalizeLocalProviders([
      {
        providerId: 'opencode-go',
        enabled: false,
        baseUrl: 'https://opencode.ai/zen/go',
        apiKeyEnv: 'OPENCODE_API_KEY',
        models: ['kimi-k2.6', 'glm-5.1', 'deepseek-v4-pro'],
        timeoutMs: 60000,
      },
    ]),
    workspaceOverrides: {},
    memory: {
      localFirst: true,
      persistSessionMemory: true,
      dataDir,
    },
    desktop: {
      reuseWebShell: true,
      webEntrypoint: 'apps/web/index.html',
      gatewayUrl: 'http://127.0.0.1:3001',
    },
    updatedAt: now,
  };
}

function normalizeSettings(input: Partial<IDESettings>, dataDir: string): IDESettings {
  const fallback = defaultSettings(dataDir);
  return {
    version: 1,
    policy: {
      ...fallback.policy,
      ...input.policy,
    },
    localProviders: normalizeLocalProviders(mergeProviderDefaults(input.localProviders, fallback.localProviders)),
    workspaceOverrides: normalizeWorkspaceOverrides(input.workspaceOverrides ?? fallback.workspaceOverrides),
    agents: { ...fallback.agents, ...input.agents },
    memory: {
      ...fallback.memory,
      ...input.memory,
      dataDir: input.memory?.dataDir || fallback.memory.dataDir,
    },
    desktop: {
      ...fallback.desktop,
      ...input.desktop,
    },
    updatedAt: input.updatedAt ?? fallback.updatedAt,
  };
}

function localProviderToConfig(provider: LocalProviderSettings): ProviderConnectionConfig {
  return {
    providerId: provider.providerId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiKeyEnv: provider.apiKeyEnv,
    timeoutMs: provider.timeoutMs,
    models: provider.models.map((modelId) => ({
      modelId,
      displayName: `${provider.providerId}/${modelId}`,
      tier: 'local',
      capabilities: LOCAL_CODE_CAPABILITIES,
      maxContextTokens: 128000,
    })),
  };
}

function normalizeLocalProviders(providers: LocalProviderSettings[]): LocalProviderSettings[] {
  return providers
    .filter((provider) => isConfigurableProviderId(provider.providerId))
    .map((provider) => ({
      providerId: provider.providerId,
      enabled: Boolean(provider.enabled),
      baseUrl: normalizeLocalProviderBaseUrl(provider.providerId, provider.baseUrl),
      apiKey: normalizeApiKey(provider.apiKey),
      apiKeyEnv: normalizeApiKeyEnv(provider.apiKeyEnv),
      models: provider.models.map((model) => model.trim()).filter(Boolean),
      timeoutMs: provider.timeoutMs > 0 ? provider.timeoutMs : 60000,
    }));
}

function mergeProviderDefaults(
  providers: LocalProviderSettings[] | undefined,
  fallbackProviders: LocalProviderSettings[],
): LocalProviderSettings[] {
  if (!providers) {
    return fallbackProviders;
  }

  const configuredIds = new Set(providers.map((provider) => provider.providerId));
  return [
    ...providers,
    ...fallbackProviders.filter((provider) => !configuredIds.has(provider.providerId)),
  ];
}

function normalizeLocalProviderBaseUrl(
  providerId: LocalProviderSettings['providerId'],
  value: string | undefined,
): string {
  const fallback = defaultProviderBaseUrl(providerId);
  const raw = value?.trim() || fallback;

  try {
    const url = new URL(raw);
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
    const isLoopback = url.hostname === 'localhost' || url.hostname === '::1' || url.hostname.startsWith('127.');
    const canUseRemote = providerId === 'opencode-go' || providerId === 'custom';
    return isHttp && (isLoopback || canUseRemote) ? url.toString().replace(/\/+$/, '') : fallback;
  } catch {
    return fallback;
  }
}

function defaultProviderBaseUrl(providerId: LocalProviderSettings['providerId']): string {
  switch (providerId) {
    case 'opencode-go':
      return 'https://opencode.ai/zen/go';
    case 'custom':
      return 'http://127.0.0.1:8000';
  }
}

function normalizeApiKeyEnv(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next || undefined;
}

function normalizeApiKey(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next || undefined;
}

function isConfigurableProviderId(value: unknown): value is LocalProviderId {
  return value === 'opencode-go' || value === 'custom';
}

function mergeWorkspaceOverrides(
  current: Record<string, WorkspaceSettingsOverride>,
  update: Record<string, WorkspaceSettingsOverride | null>,
): Record<string, WorkspaceSettingsOverride> {
  const next = { ...current };

  for (const [workspaceId, override] of Object.entries(update)) {
    if (override === null) {
      delete next[workspaceId];
      continue;
    }

    next[workspaceId] = normalizeWorkspaceOverride({
      ...override,
      workspaceId,
      updatedAt: new Date().toISOString(),
    });
  }

  return next;
}

function normalizeWorkspaceOverrides(
  overrides: Record<string, WorkspaceSettingsOverride>,
): Record<string, WorkspaceSettingsOverride> {
  const next: Record<string, WorkspaceSettingsOverride> = {};
  for (const [workspaceId, override] of Object.entries(overrides)) {
    next[workspaceId] = normalizeWorkspaceOverride({ ...override, workspaceId });
  }
  return next;
}

function normalizeWorkspaceOverride(input: WorkspaceSettingsOverride): WorkspaceSettingsOverride {
  return {
    workspaceId: input.workspaceId,
    policy: input.policy ? { ...input.policy } : undefined,
    localProviderIds: input.localProviderIds?.filter((id, index, all) => isConfigurableProviderId(id) && all.indexOf(id) === index),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
