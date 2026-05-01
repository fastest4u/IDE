import type { ModelCapabilities, ModelTier, ProviderId } from '@ide/protocol';

export interface ProviderModelConfig {
  modelId: string;
  displayName: string;
  tier: ModelTier;
  capabilities: ModelCapabilities;
  maxContextTokens: number;
  maxOutputTokens?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

export interface ProviderConnectionConfig {
  providerId: ProviderId;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: ProviderModelConfig[];
  timeoutMs?: number;
}

export interface ProviderMeshConfig {
  providers: ProviderConnectionConfig[];
}
