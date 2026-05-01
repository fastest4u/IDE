import type { FastifyRequest, FastifyReply } from 'fastify';

export interface RequestGuardOptions {
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  isOriginAllowed?: (origin: string) => boolean;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

export function createOriginGuard(options: RequestGuardOptions = {}) {
  const allowedOrigins = options.allowedOrigins ?? [];
  const isOriginAllowed = options.isOriginAllowed ?? ((origin: string) => allowedOrigins.includes(origin));
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;

  return async function originGuard(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (origin && !isOriginAllowed(origin)) {
      return reply.code(403).send({ code: 'ORIGIN_DENIED', message: 'Request origin is not allowed' });
    }

    if (!origin && !isLoopbackAddress(request.ip)) {
      return reply.code(403).send({ code: 'ORIGIN_REQUIRED', message: 'Remote requests must include an allowed origin' });
    }

    const contentLength = Number(request.headers['content-length'] ?? '0');
    if (contentLength > maxBodyBytes) {
      return reply.code(413).send({ code: 'BODY_TOO_LARGE', message: 'Request body is too large' });
    }
  };
}
