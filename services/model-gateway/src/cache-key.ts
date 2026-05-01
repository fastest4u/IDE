import { createHash } from 'node:crypto';

export interface CacheKeyInput {
  namespace: string;
  version: string;
  parts: Array<string | number | boolean | null | undefined | Record<string, unknown> | unknown[]>;
}

export function createStableCacheKey(input: CacheKeyInput): string {
  const normalized = {
    namespace: sanitizeKeyPart(input.namespace),
    version: sanitizeKeyPart(input.version),
    parts: input.parts.map((part) => normalizePart(part)),
  };

  const payload = JSON.stringify(normalized);
  const hash = createHash('sha256').update(payload).digest('hex');
  return `${normalized.namespace}:${normalized.version}:${hash.slice(0, 24)}`;
}

function normalizePart(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePart(item));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, normalizePart(item)]));
  }
  return String(value);
}

function sanitizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
