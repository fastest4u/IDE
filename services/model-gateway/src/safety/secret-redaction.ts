export class SecretRedactor {
  redact(input: string): string {
    return input
      .replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED_API_KEY]')
      .replace(/(?<=token=)[^&\s]+/gi, '[REDACTED_TOKEN]')
      .replace(/(?<=api[_-]?key=)[^&\s]+/gi, '[REDACTED_API_KEY]')
      .replace(/(?<=authorization:\s*bearer\s+)[^\s]+/gi, '[REDACTED_BEARER]')
      .replace(/(?<=x-api-key:\s*)[^\s]+/gi, '[REDACTED_API_KEY]')
      .replace(/(?<=secret=)[^&\s]+/gi, '[REDACTED_SECRET]');
  }
}
