import type { ProviderHealth } from '@ide/protocol';

export class CircuitBreaker {
  private readonly failures = new Map<ProviderHealth['providerId'], number>();

  recordFailure(providerId: ProviderHealth['providerId']): void {
    const current = this.failures.get(providerId) ?? 0;
    this.failures.set(providerId, current + 1);
  }

  recordSuccess(providerId: ProviderHealth['providerId']): void {
    this.failures.delete(providerId);
  }

  isOpen(providerId: ProviderHealth['providerId']): boolean {
    return (this.failures.get(providerId) ?? 0) >= 3;
  }
}
