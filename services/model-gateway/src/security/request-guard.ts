import type { FastifyRequest, FastifyReply } from 'fastify';

export interface RequestGuardOptions {
  allowedOrigins?: string[];
  maxBodyBytes?: number;
}

export function createOriginGuard(options: RequestGuardOptions = {}) {
  const allowedOrigins = options.allowedOrigins ?? [];
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;

  return async function originGuard(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
      return reply.code(403).send({ code: 'ORIGIN_DENIED', message: 'Request origin is not allowed' });
    }

    const contentLength = Number(request.headers['content-length'] ?? '0');
    if (contentLength > maxBodyBytes) {
      return reply.code(413).send({ code: 'BODY_TOO_LARGE', message: 'Request body is too large' });
    }
  };
}
