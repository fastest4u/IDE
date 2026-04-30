export class SecretRedactor {
  redact(input: string): string {
    return input
      .replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED_API_KEY]')
      .replace(/(?<=token=)[^&\s]+/gi, '[REDACTED_TOKEN]');
  }
}
