import type { ProviderHealth } from '@ide/protocol';

export class HealthCheckService {
  async check(providerId: ProviderHealth['providerId']): Promise<ProviderHealth> {
    return {
      providerId,
      healthy: true,
      latencyMs: 1,
      errorRate: 0,
      quotaRemaining: 100,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}
