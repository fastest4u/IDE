export interface UsageRecord {
  requestId: string;
  providerId: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  estimatedCostUsd?: number;
  role?: string;
  taskKind?: string;
  collaborationId?: string;
}

export class UsageLog {
  private readonly records: UsageRecord[] = [];

  append(record: UsageRecord): void {
    this.records.push(record);
  }

  list(): UsageRecord[] {
    return [...this.records];
  }
}
