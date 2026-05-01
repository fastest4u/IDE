import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type {
  IDESettingsUpdate,
  LocalProviderSettings,
  LocalProviderId,
  ProviderId,
  ProviderRuntimeStatus,
  ProviderRuntimeStatusResponse,
  WorkspaceSettingsOverride,
} from '@ide/protocol';

import type { AIController } from '../controller';
import type { LocalFirstSettingsService } from '../settings';

interface SettingsRoutesOptions {
  settingsService: LocalFirstSettingsService;
  controller?: AIController;
  onSettingsUpdated?: () => Promise<void> | void;
}

export const registerSettingsRoutes: FastifyPluginAsync<SettingsRoutesOptions> = async (
  app,
  options,
) => {
  const settingsService = options.settingsService;
  const controller = options.controller;

  app.get('/settings', async () => ({
    settings: settingsService.getSettings(),
  }));

  app.patch('/settings', async (request, reply) => {
    const update = request.body as IDESettingsUpdate;
    const previousSettings = settingsService.getSettings();

    try {
      const settings = settingsService.updateSettings(update);
      await options.onSettingsUpdated?.();

      if (controller && !(await localOnlyScopesAreReachable(settingsService, controller))) {
        settingsService.restoreSettings(previousSettings);
        await options.onSettingsUpdated?.();
        return reply.code(409).send({
          code: 'LOCAL_MODEL_UNAVAILABLE',
          message: 'localOnly policy requires at least one reachable local model. Enable Ollama/vLLM or keep standard routing.',
        });
      }

      return { settings };
    } catch (err) {
      settingsService.restoreSettings(previousSettings);
      await options.onSettingsUpdated?.();
      return sendSettingsError(reply, err);
    }
  });

  app.patch('/settings/workspace/:workspaceId', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = request.body as { override?: WorkspaceSettingsOverride | null };

    if (!workspaceId?.trim()) {
      return reply.code(400).send({ code: 'INVALID_WORKSPACE', message: 'workspaceId is required' });
    }

    try {
      const current = settingsService.getSettings();
      const settings = body.override === null
        ? settingsService.updateSettings({
            workspaceOverrides: {
              [workspaceId]: null,
            },
          })
        : body.override
          ? settingsService.updateWorkspaceOverride({
              ...body.override,
              workspaceId,
            })
          : null;

      if (!settings) {
        return reply.code(400).send({ code: 'INVALID_OVERRIDE', message: 'override is required' });
      }

      await options.onSettingsUpdated?.();
      if (controller && !(await localOnlyScopesAreReachable(settingsService, controller))) {
        settingsService.restoreSettings(current);
        await options.onSettingsUpdated?.();
        return reply.code(409).send({
          code: 'LOCAL_MODEL_UNAVAILABLE',
          message: 'localOnly workspace override requires at least one reachable local model.',
        });
      }

      return { settings };
    } catch (err) {
      return sendSettingsError(reply, err);
    }
  });

  app.get('/settings/local-providers', async () => ({
    providers: settingsService.getSettings().localProviders,
  }));

  app.patch('/settings/providers/:providerId', async (request, reply) => {
    const { providerId } = request.params as { providerId: ProviderId };
    if (!isLocalProviderId(providerId)) {
      return reply.code(400).send({ code: 'INVALID_PROVIDER', message: `Invalid provider: ${providerId}` });
    }

    const provider = request.body as Partial<LocalProviderSettings>;
    if (provider.providerId && provider.providerId !== providerId) {
      return reply.code(400).send({ code: 'PROVIDER_MISMATCH', message: 'Provider payload does not match route providerId.' });
    }

    const currentProvider = settingsService.getSettings().localProviders.find((item) => item.providerId === providerId);
    if (!currentProvider) {
      return reply.code(404).send({ code: 'PROVIDER_NOT_FOUND', message: `Provider settings were not found: ${providerId}` });
    }

    const previousSettings = settingsService.getSettings();
    try {
      const settings = settingsService.updateLocalProvider({
        ...currentProvider,
        ...provider,
        providerId,
      });
      await options.onSettingsUpdated?.();

      if (controller && !(await localOnlyScopesAreReachable(settingsService, controller))) {
        settingsService.restoreSettings(previousSettings);
        await options.onSettingsUpdated?.();
        return reply.code(409).send({
          code: 'LOCAL_MODEL_UNAVAILABLE',
          message: 'localOnly policy requires at least one reachable local model. Enable Ollama/vLLM or keep standard routing.',
        });
      }

      return { settings };
    } catch (err) {
      settingsService.restoreSettings(previousSettings);
      await options.onSettingsUpdated?.();
      return sendSettingsError(reply, err);
    }
  });

  app.get('/settings/provider-status', async (): Promise<ProviderRuntimeStatusResponse> => {
    const providers = await buildProviderStatuses(settingsService, controller);
    const localOnlyReady = controller ? await localOnlyScopesAreReachable(settingsService, controller) : false;
    return {
      providers,
      localOnlyReady,
      checkedAt: new Date().toISOString(),
    };
  });

  app.post('/settings/providers/:providerId/test', async (request, reply) => {
    const { providerId } = request.params as { providerId: ProviderId };
    if (!isProviderId(providerId)) {
      return reply.code(400).send({ code: 'INVALID_PROVIDER', message: `Invalid provider: ${providerId}` });
    }

    const provider = await controller?.testProviderConnection(providerId);
    if (!provider) {
      return reply.code(404).send({ code: 'PROVIDER_NOT_REGISTERED', message: `Provider is not registered: ${providerId}` });
    }

    return {
      provider,
      ok: provider.healthy,
      checkedAt: new Date().toISOString(),
    };
  });
};

async function localOnlyScopesAreReachable(
  settingsService: LocalFirstSettingsService,
  controller: AIController,
): Promise<boolean> {
  const scopes = settingsService.getLocalOnlyProviderScopes();
  if (!scopes.length) {
    return true;
  }

  for (const scope of scopes) {
    if (!(await controller.hasReachableLocalModel(scope))) {
      return false;
    }
  }

  return true;
}

async function buildProviderStatuses(
  settingsService: LocalFirstSettingsService,
  controller?: AIController,
): Promise<ProviderRuntimeStatus[]> {
  const runtimeStatuses = controller ? await controller.getProviderStatuses() : [];
  const byProvider = new Map(runtimeStatuses.map((status) => [status.providerId, status]));

  for (const provider of settingsService.getSettings().localProviders) {
    if (!byProvider.has(provider.providerId)) {
      byProvider.set(provider.providerId, {
        providerId: provider.providerId,
        healthy: false,
        registered: false,
        enabled: provider.enabled,
        modelIds: provider.models,
        models: provider.models.map((modelId) => ({
          providerId: provider.providerId,
          modelId,
          displayName: `${provider.providerId}/${modelId}`,
          tier: 'local',
          capabilities: [],
        })),
        errorRate: provider.enabled ? 1 : 0,
        lastCheckedAt: new Date().toISOString(),
        notes: [provider.enabled ? 'provider is enabled but not registered' : 'provider is disabled'],
      });
      continue;
    }

    const runtime = byProvider.get(provider.providerId);
    if (runtime) {
      byProvider.set(provider.providerId, {
        ...runtime,
        enabled: provider.enabled,
      });
    }
  }

  return [...byProvider.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function sendSettingsError(reply: FastifyReply, err: unknown) {
  return reply.code(400).send({
    code: 'SETTINGS_UPDATE_FAILED',
    message: err instanceof Error ? err.message : String(err),
  });
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === 'anthropic' ||
    value === 'openai' ||
    value === 'gemini' ||
    value === 'mistral' ||
    value === 'deepseek' ||
    value === 'ollama' ||
    value === 'vllm' ||
    value === 'opencode-go' ||
    value === 'custom'
  );
}

function isLocalProviderId(value: unknown): value is LocalProviderId {
  return value === 'opencode-go' || value === 'custom';
}
