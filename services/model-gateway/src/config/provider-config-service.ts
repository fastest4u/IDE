import type { ModelDescriptor, ProviderAdapter } from '@ide/protocol';

import type { ProviderConnectionConfig } from './provider-config';

import { InMemoryModelRegistry } from '../router/registry';

export class ProviderConfigService {
  constructor(
    private readonly registry: InMemoryModelRegistry,
    private readonly adapterFactory: (config: ProviderConnectionConfig) => ProviderAdapter | null,
  ) {}

  load(configs: ProviderConnectionConfig[]): Map<ProviderAdapter['providerId'], ProviderAdapter> {
    const adapterMap = new Map<ProviderAdapter['providerId'], ProviderAdapter>();

    for (const config of configs) {
      const adapter = this.adapterFactory(config);
      if (!adapter) continue;

      adapterMap.set(config.providerId, adapter);

      for (const model of config.models) {
        const descriptor: ModelDescriptor = {
          providerId: config.providerId,
          modelId: model.modelId,
          displayName: model.displayName,
          tier: model.tier,
          capabilities: model.capabilities,
          maxContextTokens: model.maxContextTokens,
          maxOutputTokens: model.maxOutputTokens,
          costPerInputToken: model.costPerInputToken,
          costPerOutputToken: model.costPerOutputToken,
        };
        this.registry.register(descriptor);
      }
    }

    return adapterMap;
  }
}
