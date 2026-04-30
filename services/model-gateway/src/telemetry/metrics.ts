export class MetricsCollector {
  private readonly counters = new Map<string, number>();

  increment(metric: string): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + 1);
  }

  get(metric: string): number {
    return this.counters.get(metric) ?? 0;
  }
}
