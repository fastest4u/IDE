import type {
  AIRequest,
  CollaborationRole,
  ModelDescriptor,
  ProviderHealth,
  ProviderPolicyEngine,
  RoutingCandidate,
  RoutingDecision,
} from '@ide/protocol';

export class BasicPolicyEngine implements ProviderPolicyEngine {
  async score(
    request: AIRequest,
    models: ModelDescriptor[],
    health: ProviderHealth[],
  ): Promise<RoutingCandidate[]> {
    return models.map((model) => {
      const healthEntry = health.find((item) => item.providerId === model.providerId);
      const latencyPenalty = healthEntry?.latencyMs ? Math.min(healthEntry.latencyMs / 1000, 5) : 0;
      const errorPenalty = healthEntry?.errorRate ? healthEntry.errorRate * 10 : 0;
      const role = getCollaborationRole(request);
      const preferredTierBonus = request.preferredModelTier === model.tier ? 8 : 0;
      const capabilityBonus = (request.preferredCapabilities ?? []).reduce<number>(
        (total, capability) => total + (model.capabilities[capability] ? 4 : -8),
        0,
      );
      const roleBonus = role ? scoreRoleFit(role, model) : 0;
      const strategyBonus = scoreStrategyFit(request, model, healthEntry);
      const score = 100 - latencyPenalty - errorPenalty + preferredTierBonus + capabilityBonus + roleBonus + strategyBonus;

      return {
        model,
        score,
        reasons: [
          healthEntry?.healthy === false ? 'provider unhealthy' : 'provider healthy',
          healthEntry?.latencyMs ? `latency=${healthEntry.latencyMs}ms` : 'latency unknown',
          role ? `role=${role}` : 'single-model request',
          request.preferredModelTier ? `preferredTier=${request.preferredModelTier}` : 'no tier preference',
        ],
      };
    });
  }

  async choose(request: AIRequest, candidates: RoutingCandidate[]): Promise<RoutingDecision> {
    const ordered = [...candidates].sort((a, b) => b.score - a.score);
    const chosen = ordered[0]?.model ?? {
      providerId: 'custom',
      modelId: 'placeholder-model',
      displayName: 'Placeholder Model',
      tier: 'balanced',
      capabilities: {
        tools: true,
        vision: false,
        reasoning: true,
        streaming: true,
        longContext: true,
        codeEditing: true,
        embeddings: false,
        reranking: false,
      },
      maxContextTokens: 128000,
    };

    return {
      requestId: request.id,
      chosen,
      candidates: ordered,
      strategy: request.strategy ?? 'primary',
      fallbackChain: ordered.slice(1).map((candidate) => candidate.model),
      decidedAt: new Date().toISOString(),
    };
  }
}

function getCollaborationRole(request: AIRequest): CollaborationRole | undefined {
  const value = request.context.metadata?.collaborationRole;
  if (
    value === 'planner' ||
    value === 'context_curator' ||
    value === 'coder' ||
    value === 'reviewer' ||
    value === 'verifier' ||
    value === 'synthesizer'
  ) {
    return value;
  }
  return undefined;
}

function scoreRoleFit(role: CollaborationRole, model: ModelDescriptor): number {
  switch (role) {
    case 'planner':
      return scoreReasoningRole(model, 14);
    case 'context_curator':
      return (model.capabilities.longContext ? 12 : -10) + (model.tier === 'fast' || model.tier === 'local' ? 6 : 0);
    case 'coder':
      return (model.capabilities.codeEditing ? 14 : -16) + (model.capabilities.tools ? 4 : 0);
    case 'reviewer':
      return scoreReasoningRole(model, 12) + (model.capabilities.codeEditing ? 5 : 0);
    case 'verifier':
      return (model.capabilities.codeEditing ? 6 : -6) + (model.tier === 'fast' || model.tier === 'local' ? 8 : 0);
    case 'synthesizer':
      return scoreReasoningRole(model, 8) + (model.capabilities.longContext ? 6 : 0);
  }
}

function scoreReasoningRole(model: ModelDescriptor, base: number): number {
  return (model.capabilities.reasoning ? base : -base) + (model.tier === 'premium' ? 6 : 0);
}

function scoreStrategyFit(
  request: AIRequest,
  model: ModelDescriptor,
  healthEntry: ProviderHealth | undefined,
): number {
  switch (request.strategy) {
    case 'costOptimized':
      return model.costPerInputToken || model.costPerOutputToken ? -((model.costPerInputToken ?? 0) + (model.costPerOutputToken ?? 0)) * 1000 : 2;
    case 'latencyOptimized':
      return healthEntry?.latencyMs ? Math.max(0, 10 - healthEntry.latencyMs / 100) : 0;
    case 'localOnly':
      return model.tier === 'local' ? 12 : -100;
    case 'committee':
      return model.capabilities.reasoning ? 4 : 0;
    case 'fallback':
    case 'primary':
    case undefined:
      return 0;
  }
}
