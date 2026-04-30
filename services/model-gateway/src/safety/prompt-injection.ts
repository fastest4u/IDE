export class PromptInjectionGuard {
  isSuspicious(input: string): boolean {
    const patterns = [/ignore previous instructions/i, /reveal system prompt/i, /exfiltrate/i];
    return patterns.some((pattern) => pattern.test(input));
  }
}
