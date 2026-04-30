export class FallbackPlanner {
  buildFallbackChain(primaryModelId: string, candidates: string[]): string[] {
    return candidates.filter((candidate) => candidate !== primaryModelId);
  }
}
