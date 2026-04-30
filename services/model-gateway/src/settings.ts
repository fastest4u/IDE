import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type {
  EffectiveIDESettings,
  IDESettings,
  IDESettingsUpdate,
  LocalProviderSettings,
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
      updatedAt: new Date().toISOString(),
    };

    this.settings = normalizeSettings(next, this.dataDir);
    this.persistSettings();
    return this.getSettings();
  }

  restoreSettings(settings: IDESettings): IDESettings {
    this.settings = normalizeSettings(settings, this.dataDir);
    this.persistSettings();
    return this.getSettings();
  }

  getLocalProviderConfigs(): ProviderConnectionConfig[] {
    return this.settings.localProviders
      .filter((provider) => provider.enabled && provider.models.length > 0)
      .map((provider) => ({
        providerId: provider.providerId,
        baseUrl: provider.baseUrl,
        timeoutMs: provider.timeoutMs,
        models: provider.models.map((modelId) => ({
          modelId,
          displayName: `${provider.providerId}/${modelId}`,
          tier: 'local',
          capabilities: LOCAL_CODE_CAPABILITIES,
          maxContextTokens: provider.providerId === 'ollama' ? 32768 : 128000,
        })),
      }));
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
    },
    localProviders: normalizeLocalProviders([
      {
        providerId: 'ollama',
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434',
        models: ['llama3.2', 'qwen2.5-coder:7b'],
        timeoutMs: 60000,
      },
      {
        providerId: 'vllm',
        enabled: false,
        baseUrl: 'http://127.0.0.1:8000',
        models: ['local-model'],
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
    localProviders: normalizeLocalProviders(input.localProviders ?? fallback.localProviders),
    workspaceOverrides: normalizeWorkspaceOverrides(input.workspaceOverrides ?? fallback.workspaceOverrides),
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
    timeoutMs: provider.timeoutMs,
    models: provider.models.map((modelId) => ({
      modelId,
      displayName: `${provider.providerId}/${modelId}`,
      tier: 'local',
      capabilities: LOCAL_CODE_CAPABILITIES,
      maxContextTokens: provider.providerId === 'ollama' ? 32768 : 128000,
    })),
  };
}

function normalizeLocalProviders(providers: LocalProviderSettings[]): LocalProviderSettings[] {
  return providers
    .filter((provider) => provider.providerId === 'ollama' || provider.providerId === 'vllm')
    .map((provider) => ({
      providerId: provider.providerId,
      enabled: Boolean(provider.enabled),
      baseUrl: provider.baseUrl?.trim() || (provider.providerId === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8000'),
      models: provider.models.map((model) => model.trim()).filter(Boolean),
      timeoutMs: provider.timeoutMs > 0 ? provider.timeoutMs : 60000,
    }));
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
    localProviderIds: input.localProviderIds?.filter((id, index, all) => (id === 'ollama' || id === 'vllm') && all.indexOf(id) === index),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
