import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';

import type { ProviderAdapter } from '@ide/protocol';

import type { ProviderConnectionConfig } from './config/provider-config';

import { AIController } from './controller';
import { registerHealthRoutes } from './routes/health';
import { registerAIRoutes } from './routes/ai';
import { registerPatchRoutes } from './routes/patches';
import { registerSessionRoutes } from './routes/sessions';
import { registerWorkspaceRoutes } from './routes/workspace';
import { registerSettingsRoutes } from './routes/settings';
import { registerTerminalRoutes } from './routes/terminal';
import { PatchService, FileBackedPatchStore } from './patches';

import { AIRouterEngine } from './router/ai-router';
import { InMemoryModelRegistry } from './router/registry';
import { BasicPolicyEngine } from './router/policy-engine';
import { FallbackPlanner } from './router/fallback';
import { HealthCheckService } from './health/health-check';
import { CircuitBreaker } from './health/circuit-breaker';
import { UsageLog } from './telemetry/usage-log';
import { AuditLogService } from './telemetry/audit-log';
import { ResponseValidator } from './safety/response-validator';
import { SecretRedactor } from './safety/secret-redaction';
import { PromptInjectionGuard } from './safety/prompt-injection';
import { ProviderConfigService } from './config/provider-config-service';
import { InMemorySessionStore } from './memory/session-store';
import { AnthropicAdapter } from './adapters/anthropic-adapter';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible-adapter';
import { OllamaAdapter } from './adapters/ollama-adapter';
import { WorkspaceWriter } from './workspace-writer';
import { resolveWorkspaceRootInput } from './memory/workspace-context';
import { LocalFirstSettingsService } from './settings';
import { TerminalSessionService } from './terminal/terminal-session';
import { createOriginGuard } from './security/request-guard';
import { NativeWorkspacePickerService, type WorkspacePickerService } from './workspace-picker';

export interface ModelGatewayServerOptions {
  port?: number;
  host?: string;
  logger?: boolean;
  providerConfigs?: ProviderConnectionConfig[];
  workspaceRoot?: string;
  dataDir?: string;
  workspacePicker?: WorkspacePickerService;
}

const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
];

function getAllowedOrigins(): string[] {
  const configured = process.env.IDE_ALLOWED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function buildAdapter(config: ProviderConnectionConfig): ProviderAdapter | null {
  switch (config.providerId) {
    case 'anthropic':
      return new AnthropicAdapter();
    case 'ollama':
      return new OllamaAdapter({
        models: config.models.map((m) => m.modelId),
        baseUrl: config.baseUrl ?? 'http://127.0.0.1:11434',
        timeoutMs: config.timeoutMs,
      });
    case 'openai':
    case 'gemini':
    case 'mistral':
    case 'deepseek':
    case 'vllm':
    case 'custom':
      return new OpenAICompatibleAdapter({
        providerId: config.providerId,
        baseUrl: config.baseUrl,
        apiKey: config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined,
        models: config.models.map((m) => m.modelId),
        timeoutMs: config.timeoutMs,
      });
    default:
      return null;
  }
}

function buildProviderRuntime(providerConfigs: ProviderConnectionConfig[] = []) {
  const registry = new InMemoryModelRegistry();
  const policy = new BasicPolicyEngine();
  const health = new HealthCheckService();
  const breaker = new CircuitBreaker();
  const fallback = new FallbackPlanner();
  const usageLog = new UsageLog();
  const validator = new ResponseValidator();
  const redactor = new SecretRedactor();
  const injectionGuard = new PromptInjectionGuard();

  const configService = new ProviderConfigService(registry, buildAdapter);
  const adapters = new Map<ProviderAdapter['providerId'], ProviderAdapter>();

  const reloadProviders = (configs: ProviderConnectionConfig[]) => {
    registry.clear();
    adapters.clear();
    const loadedAdapters = configService.load(configs);
    for (const [providerId, adapter] of loadedAdapters) {
      adapters.set(providerId, adapter);
    }
  };

  reloadProviders(providerConfigs);

  const router = new AIRouterEngine({
    registry,
    policy,
    health,
    breaker,
    fallback,
    adapters,
    usageLog,
    validator,
    redactor,
    injectionGuard,
  });

  return { router, reloadProviders };
}

export async function createModelGatewayServer(
  options: Pick<ModelGatewayServerOptions, 'logger' | 'providerConfigs' | 'workspaceRoot' | 'dataDir' | 'workspacePicker'> = {},
) {
  const app = Fastify({
    logger: options.logger ?? true,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        useDefaults: true,
        coerceTypes: true,
      },
    },
  });

  const workspaceRoot = resolveWorkspaceRootInput(options.workspaceRoot ?? process.env.IDE_WORKSPACE_ROOT ?? process.cwd());
  const settingsService = new LocalFirstSettingsService(options.dataDir);
  const staticProviderConfigs = options.providerConfigs ?? [];
  const providerConfigs = [...settingsService.getLocalProviderConfigs(), ...staticProviderConfigs];
  const providerRuntime = buildProviderRuntime(providerConfigs);
  const reloadProviderRuntime = () => providerRuntime.reloadProviders([...settingsService.getLocalProviderConfigs(), ...staticProviderConfigs]);
  const sessionStore = new InMemorySessionStore({
    persist: settingsService.getSettings().memory.persistSessionMemory,
    persistenceFilePath: path.join(settingsService.getDataDir(), 'sessions.json'),
  });
  const patchStore = new FileBackedPatchStore({
    filePath: path.join(settingsService.getDataDir(), 'patches.json'),
  });
  const patchService = new PatchService(
    patchStore,
    new WorkspaceWriter(workspaceRoot),
    sessionStore,
  );
  const terminalService = new TerminalSessionService(workspaceRoot);
  const workspacePicker = options.workspacePicker ?? new NativeWorkspacePickerService();
  const auditLog = new AuditLogService({
    filePath: path.join(settingsService.getDataDir(), 'audit-log.json'),
  });
  const controller = new AIController(
    providerRuntime.router,
    undefined,
    sessionStore,
    undefined,
    undefined,
    patchService,
    undefined,
    settingsService,
  );

  const allowedOrigins = getAllowedOrigins();

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  app.addHook('onRequest', createOriginGuard({
    allowedOrigins,
    maxBodyBytes: Number(process.env.IDE_MAX_BODY_BYTES ?? '262144'),
  }));

  app.get('/health', async () => ({ status: 'ok' as const }));
  app.register(registerHealthRoutes, { controller });
  app.register(registerAIRoutes, { controller });
  app.register(registerPatchRoutes, { patchService });
  app.register(registerSessionRoutes, { controller });
  app.register(registerWorkspaceRoutes, { controller, patchService, terminalService, workspacePicker });
  app.register(registerSettingsRoutes, {
    settingsService,
    controller,
    onSettingsUpdated: reloadProviderRuntime,
  });
  app.register(registerTerminalRoutes, { terminalService });
  app.addHook('onReady', async () => {
    await patchStore.hydrate();
    await controller.setWorkspaceRoot(workspaceRoot);
    const activeWorkspaceRoot = controller.getWorkspaceRoot() ?? workspaceRoot;
    patchService.setWorkspaceRoot(activeWorkspaceRoot);
    terminalService.setWorkspaceRoot(activeWorkspaceRoot);
    await auditLog.append({ action: 'workspace.save', entityId: 'bootstrap', workspaceRoot: activeWorkspaceRoot, details: { status: 'ready' } });
  });

  return { app, controller, router: providerRuntime.router };
}

export async function startModelGatewayServer(options: ModelGatewayServerOptions = {}) {
  const { app } = await createModelGatewayServer({
    logger: options.logger,
    providerConfigs: options.providerConfigs,
    workspaceRoot: options.workspaceRoot,
    dataDir: options.dataDir,
    workspacePicker: options.workspacePicker,
  });
  const port = options.port ?? 3001;
  const host = options.host ?? '127.0.0.1';

  await app.listen({ port, host });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startModelGatewayServer();
}
