export class PromptInjectionGuard {
  isSuspicious(input: string): boolean {
    const patterns = [
      /ignore\s+previous\s+instructions/i,
      /disregard\s+all\s+prior\s+instructions/i,
      /reveal\s+system\s+prompt/i,
      /show\s+system\s+message/i,
      /exfiltrat(e|ion)|steal\s+(secrets?|credentials?|tokens?)/i,
      /developer\s+message/i,
      /tool\s+call\s+schema/i,
      /bypass.*policy/i,
      /(?:base64|hex)\s*[:=]/i,
    ];

    return patterns.some((pattern) => pattern.test(input));
  }
}
