import type {
  AIRequest,
  AIResponse,
  AIStreamEvent,
  ModelDescriptor,
  ProviderAdapter,
  ProviderHealth,
  ProviderId,
  ProviderRuntimeStatus,
  RoutingDecision,
} from '@ide/protocol';

import { InMemoryModelRegistry } from './registry';
import { BasicPolicyEngine } from './policy-engine';
import { HealthCheckService } from '../health/health-check';
import { CircuitBreaker } from '../health/circuit-breaker';
import { FallbackPlanner } from './fallback';
import { UsageLog } from '../telemetry/usage-log';
import { ResponseValidator } from '../safety/response-validator';
import { SecretRedactor } from '../safety/secret-redaction';
import { PromptInjectionGuard } from '../safety/prompt-injection';

export interface AIRouterEngineDeps {
  registry: InMemoryModelRegistry;
  policy: BasicPolicyEngine;
  health: HealthCheckService;
  breaker: CircuitBreaker;
  fallback: FallbackPlanner;
  adapters: Map<ProviderId, ProviderAdapter>;
  usageLog: UsageLog;
  validator: ResponseValidator;
  redactor: SecretRedactor;
  injectionGuard: PromptInjectionGuard;
}

export class AIRouterEngine {
  constructor(private readonly deps: AIRouterEngineDeps) {}

  async route(request: AIRequest): Promise<RoutingDecision> {
    if (request.prompt && this.deps.injectionGuard.isSuspicious(request.prompt)) {
      return {
        requestId: request.id,
        chosen: this.fallbackModel(),
        candidates: [],
        strategy: 'fallback',
        fallbackChain: [],
        decidedAt: new Date().toISOString(),
      };
    }

    const allModels = await this.deps.registry.listModels();

    let candidates = allModels;

    const allowedProviderIds = stringArrayMetadata(request, 'allowedProviderIds');
    if (allowedProviderIds.length) {
      candidates = candidates.filter((model) => allowedProviderIds.includes(model.providerId));
    }

    if (request.strategy === 'localOnly') {
      candidates = candidates.filter((m) => m.tier === 'local');
    }

    if (request.preferredCapabilities?.length) {
      const capabilityMatches = candidates.filter((model) =>
        request.preferredCapabilities?.every((capability) => model.capabilities[capability]),
      );
      if (capabilityMatches.length > 0) {
        candidates = capabilityMatches;
      }
    }

    const uniqueProviders = [...new Set(candidates.map((m) => m.providerId))];
    const healthResults = await Promise.all(uniqueProviders.map((id) => this.checkProviderHealth(id)));

    const healthyCandidates = candidates.filter((m) => {
      if (this.deps.breaker.isOpen(m.providerId)) return false;
      const h = healthResults.find((r) => r.providerId === m.providerId);
      return h?.healthy !== false;
    });

    if (healthyCandidates.length === 0) {
      if (request.strategy === 'localOnly') {
        throw new Error('No reachable local model is available for localOnly routing');
      }

      return {
        requestId: request.id,
        chosen: this.fallbackModel(),
        candidates: [],
        strategy: 'fallback',
        fallbackChain: [],
        decidedAt: new Date().toISOString(),
      };
    }

    const scored = await this.deps.policy.score(request, healthyCandidates, healthResults);
    return this.deps.policy.choose(request, scored);
  }

  async execute(request: AIRequest, decision: RoutingDecision): Promise<AIResponse> {
    const redactedPrompt = this.deps.redactor.redact(request.prompt);

    const tryModel = async (model: ModelDescriptor): Promise<AIResponse> => {
      const adapter = this.deps.adapters.get(model.providerId);

      if (!adapter) {
        throw new Error(`No adapter registered for provider ${model.providerId}`);
      }

      const startTime = Date.now();

      const result = await adapter.generateText({
        requestId: request.id,
        modelId: model.modelId,
        prompt: redactedPrompt,
        context: request.context,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        tools: request.tools,
        stream: false,
      });

      const latencyMs = Date.now() - startTime;

      this.deps.usageLog.append({
        requestId: request.id,
        providerId: adapter.providerId,
        modelId: model.modelId,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        latencyMs,
        estimatedCostUsd: result.usage?.estimatedCostUsd,
        role: stringMetadata(request, 'collaborationRole'),
        taskKind: request.kind,
        collaborationId: stringMetadata(request, 'collaborationId'),
      });

      await this.deps.validator.validateResponse({
        requestId: request.id,
        providerId: adapter.providerId,
        modelId: model.modelId,
        text: result.text,
      });

      return {
        requestId: request.id,
        providerId: adapter.providerId,
        modelId: model.modelId,
        text: result.text,
        usage: { ...result.usage, latencyMs },
        warnings: result.toolCalls?.map((tc) => `Tool call: ${tc.name}`),
        metadata: { strategy: decision.strategy, toolCalls: result.toolCalls },
      };
    };

    try {
      const response = await tryModel(decision.chosen);
      this.deps.breaker.recordSuccess(decision.chosen.providerId);
      return response;
    } catch (err) {
      this.deps.breaker.recordFailure(decision.chosen.providerId);

      for (const fallback of decision.fallbackChain) {
        if (this.deps.breaker.isOpen(fallback.providerId)) continue;

        try {
          const response = await tryModel(fallback);
          this.deps.breaker.recordSuccess(fallback.providerId);
          return {
            ...response,
            warnings: [
              ...(response.warnings ?? []),
              `Fell back from ${decision.chosen.providerId}/${decision.chosen.modelId} to ${fallback.providerId}/${fallback.modelId}`,
            ],
            metadata: { ...response.metadata, fallbackFrom: decision.chosen.modelId },
          };
        } catch {
          this.deps.breaker.recordFailure(fallback.providerId);
        }
      }

      throw new Error(
        `All providers failed for request ${request.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  getAdapter(providerId: ProviderId): ProviderAdapter | undefined {
    return this.deps.adapters.get(providerId);
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.deps.registry.listModels();
  }

  replaceAdapters(adapters: Map<ProviderId, ProviderAdapter>): void {
    this.deps.adapters.clear();
    for (const [providerId, adapter] of adapters) {
      this.deps.adapters.set(providerId, adapter);
    }
  }

  async getProviderStatuses(): Promise<ProviderRuntimeStatus[]> {
    const models = await this.deps.registry.listModels();
    const providerIds = [...new Set([
      ...models.map((model) => model.providerId),
      ...this.deps.adapters.keys(),
    ])].sort();

    return Promise.all(providerIds.map(async (providerId) => this.getProviderStatus(providerId, models)));
  }

  async testProviderConnection(providerId: ProviderId): Promise<ProviderRuntimeStatus | null> {
    const adapter = this.deps.adapters.get(providerId);
    if (!adapter) {
      return null;
    }

    return this.getProviderStatus(providerId, await this.deps.registry.listModels());
  }

  async hasReachableLocalModel(allowedProviderIds?: ProviderId[]): Promise<boolean> {
    const statuses = await this.getProviderStatuses();
    return statuses.some((status) => {
      if (!status.healthy) {
        return false;
      }
      if (allowedProviderIds?.length && !allowedProviderIds.includes(status.providerId)) {
        return false;
      }
      return status.models.some((model) => model.tier === 'local');
    });
  }

  getUsageLog(): UsageLog {
    return this.deps.usageLog;
  }

  private async getProviderStatus(
    providerId: ProviderId,
    allModels: ModelDescriptor[],
  ): Promise<ProviderRuntimeStatus> {
    const models = allModels.filter((model) => model.providerId === providerId);
    const health = await this.checkProviderHealth(providerId);
    const adapter = this.deps.adapters.get(providerId);

    return {
      ...health,
      registered: Boolean(adapter),
      enabled: Boolean(adapter),
      modelIds: models.map((model) => model.modelId),
      models: models.map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        displayName: model.displayName,
        tier: model.tier,
        capabilities: Object.entries(model.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([capability]) => capability),
      })),
    };
  }

  private async checkProviderHealth(providerId: ProviderId): Promise<ProviderHealth> {
    const adapter = this.deps.adapters.get(providerId);
    if (!adapter) {
      return {
        providerId,
        healthy: false,
        errorRate: 1,
        lastCheckedAt: new Date().toISOString(),
        notes: ['provider adapter is not registered'],
      };
    }

    try {
      return await adapter.healthCheck();
    } catch (err) {
      return {
        providerId,
        healthy: false,
        errorRate: 1,
        lastCheckedAt: new Date().toISOString(),
        notes: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  private fallbackModel(): ModelDescriptor {
    return {
      providerId: 'custom',
      modelId: 'fallback-model',
      displayName: 'Fallback Model',
      tier: 'balanced',
      capabilities: {
        tools: false,
        vision: false,
        reasoning: false,
        streaming: false,
        longContext: false,
        codeEditing: false,
        embeddings: false,
        reranking: false,
      },
      maxContextTokens: 8096,
    };
  }
}

function stringMetadata(request: AIRequest, key: string): string | undefined {
  const value = request.context.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringArrayMetadata(request: AIRequest, key: string): ProviderId[] {
  const value = request.context.metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isProviderId);
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
    value === 'custom'
  );
}
