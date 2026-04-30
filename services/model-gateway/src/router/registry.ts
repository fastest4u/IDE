import type { AICapability, ModelDescriptor, ModelRegistry, ProviderId } from '@ide/protocol';

export class InMemoryModelRegistry implements ModelRegistry {
  private readonly models: ModelDescriptor[] = [];

  constructor(initialModels: ModelDescriptor[] = []) {
    this.models.push(...initialModels);
  }

  register(model: ModelDescriptor): void {
    const existing = this.models.findIndex(
      (m) => m.providerId === model.providerId && m.modelId === model.modelId,
    );
    if (existing !== -1) {
      this.models[existing] = model;
    } else {
      this.models.push(model);
    }
  }

  clear(): void {
    this.models.length = 0;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }

  async getModel(providerId: ProviderId, modelId: string): Promise<ModelDescriptor | null> {
    return this.models.find((model) => model.providerId === providerId && model.modelId === modelId) ?? null;
  }

  async listByCapability(capability: AICapability): Promise<ModelDescriptor[]> {
    return this.models.filter((model) => model.capabilities[capability]);
  }

  async listHealthyModels(): Promise<ModelDescriptor[]> {
    return this.models;
  }
}
