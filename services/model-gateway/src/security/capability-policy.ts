import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuditLogService } from '../telemetry/audit-log';

export type LocalCapability =
  | 'agent.read'
  | 'agent.write'
  | 'agent.run.create'
  | 'agent.run.read'
  | 'agent.run.cancel'
  | 'ai.embed'
  | 'ai.generate'
  | 'ai.rerank'
  | 'memory.read'
  | 'memory.write'
  | 'obsidian.database.read'
  | 'obsidian.rag.read'
  | 'patch.apply'
  | 'patch.approve'
  | 'patch.create'
  | 'patch.read'
  | 'patch.rollback'
  | 'session.read'
  | 'session.write'
  | 'settings.read'
  | 'settings.update'
  | 'terminal.execute'
  | 'terminal.kill'
  | 'terminal.read'
  | 'terminal.write'
  | 'toolApproval.decide'
  | 'toolApproval.read'
  | 'trace.read'
  | 'workflow.approve'
  | 'workflow.read'
  | 'workflow.write'
  | 'workspace.read'
  | 'workspace.switch'
  | 'workspace.write';

export type LocalCapabilityProfile = 'local-user' | 'agent-runtime' | 'readonly';

export interface LocalCapabilityIdentity {
  id: string;
  profile: LocalCapabilityProfile;
  capabilities: LocalCapability[];
}

export interface CapabilityDecision {
  allowed: boolean;
  capability?: LocalCapability;
  identity: LocalCapabilityIdentity;
  reason?: string;
}

export interface LocalCapabilityPolicyOptions {
  defaultProfile?: LocalCapabilityProfile;
  auditLog?: AuditLogService;
}

const ALL_CAPABILITIES: LocalCapability[] = [
  'agent.read',
  'agent.write',
  'agent.run.create',
  'agent.run.read',
  'agent.run.cancel',
  'ai.embed',
  'ai.generate',
  'ai.rerank',
  'memory.read',
  'memory.write',
  'obsidian.database.read',
  'obsidian.rag.read',
  'patch.apply',
  'patch.approve',
  'patch.create',
  'patch.read',
  'patch.rollback',
  'session.read',
  'session.write',
  'settings.read',
  'settings.update',
  'terminal.execute',
  'terminal.kill',
  'terminal.read',
  'terminal.write',
  'toolApproval.decide',
  'toolApproval.read',
  'trace.read',
  'workflow.approve',
  'workflow.read',
  'workflow.write',
  'workspace.read',
  'workspace.switch',
  'workspace.write',
];

const READONLY_CAPABILITIES: LocalCapability[] = [
  'agent.read',
  'agent.run.read',
  'ai.generate',
  'memory.read',
  'obsidian.database.read',
  'obsidian.rag.read',
  'patch.read',
  'session.read',
  'settings.read',
  'terminal.read',
  'toolApproval.read',
  'trace.read',
  'workflow.read',
  'workspace.read',
];

const AGENT_RUNTIME_CAPABILITIES: LocalCapability[] = [
  'agent.read',
  'agent.run.create',
  'agent.run.read',
  'ai.embed',
  'ai.generate',
  'ai.rerank',
  'memory.read',
  'memory.write',
  'obsidian.database.read',
  'obsidian.rag.read',
  'patch.create',
  'patch.read',
  'session.read',
  'session.write',
  'terminal.read',
  'trace.read',
  'workflow.read',
  'workspace.read',
];

const PROFILE_CAPABILITIES: Record<LocalCapabilityProfile, LocalCapability[]> = {
  'local-user': ALL_CAPABILITIES,
  'agent-runtime': AGENT_RUNTIME_CAPABILITIES,
  readonly: READONLY_CAPABILITIES,
};

export class LocalCapabilityPolicyService {
  constructor(private readonly options: LocalCapabilityPolicyOptions = {}) {}

  getIdentity(request: FastifyRequest): LocalCapabilityIdentity {
    const profile = normalizeProfile(headerValue(request.headers['x-ide-capability-profile'])) ?? this.options.defaultProfile ?? 'local-user';
    const requestedId = headerValue(request.headers['x-ide-actor-id']);
    return {
      id: requestedId || profile,
      profile,
      capabilities: PROFILE_CAPABILITIES[profile],
    };
  }

  decide(request: FastifyRequest): CapabilityDecision {
    const identity = this.getIdentity(request);
    const capability = capabilityForRequest(request.method, request.url);
    if (!capability) {
      return { allowed: true, identity };
    }
    if (identity.capabilities.includes(capability)) {
      return { allowed: true, capability, identity };
    }
    return {
      allowed: false,
      capability,
      identity,
      reason: `${identity.profile} cannot use ${capability}`,
    };
  }

  createGuard() {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const decision = this.decide(request);
      request.headers['x-ide-actor-id'] = decision.identity.id;
      request.headers['x-ide-capability-profile'] = decision.identity.profile;
      if (decision.allowed) return;

      await this.options.auditLog?.append({
        action: 'capability.denied',
        entityId: `${request.method} ${request.url}`,
        actor: decision.identity.id,
        details: {
          capability: decision.capability,
          profile: decision.identity.profile,
          reason: decision.reason,
        },
      });

      return reply.code(403).send({
        code: 'CAPABILITY_DENIED',
        message: decision.reason ?? 'Capability denied by local policy',
        capability: decision.capability,
        actor: decision.identity.id,
        profile: decision.identity.profile,
      });
    };
  }
}

function capabilityForRequest(method: string, rawUrl: string): LocalCapability | null {
  const pathname = normalizePathname(rawUrl);
  const upperMethod = method.toUpperCase();

  if (pathname === '/health' || pathname.startsWith('/health/')) return null;

  if (pathname === '/agents') return upperMethod === 'GET' ? 'agent.read' : 'agent.write';
  if (pathname === '/agents/runs') return upperMethod === 'GET' ? 'agent.run.read' : 'agent.run.create';
  if (pathname.startsWith('/agents/runs/')) {
    if (pathname.endsWith('/cancel')) return 'agent.run.cancel';
    return 'agent.run.read';
  }
  if (pathname.startsWith('/agents/')) return upperMethod === 'GET' ? 'agent.read' : 'agent.write';

  if (pathname === '/ai/generate' || pathname === '/ai/stream' || pathname === '/ai/collaborate' || pathname === '/ai/agent') return 'ai.generate';
  if (pathname === '/ai/embed') return 'ai.embed';
  if (pathname === '/ai/rerank') return 'ai.rerank';

  if (pathname === '/memory/obsidian/rag') return 'obsidian.rag.read';
  if (pathname === '/memory/obsidian/database') return 'obsidian.database.read';
  if (pathname.startsWith('/memory/')) return upperMethod === 'GET' || upperMethod === 'POST' ? 'memory.read' : 'memory.write';

  if (pathname === '/patches') return upperMethod === 'GET' ? 'patch.read' : 'patch.create';
  if (pathname.startsWith('/patches/')) {
    if (pathname.endsWith('/approve') || pathname.endsWith('/reject') || pathname.endsWith('/review')) return 'patch.approve';
    if (pathname.endsWith('/apply')) return 'patch.apply';
    if (pathname.endsWith('/rollback')) return 'patch.rollback';
    return upperMethod === 'GET' ? 'patch.read' : 'patch.create';
  }

  if (pathname === '/sessions') return 'session.read';
  if (pathname.startsWith('/sessions/')) return upperMethod === 'GET' ? 'session.read' : 'session.write';

  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    return upperMethod === 'GET' || pathname.endsWith('/test') ? 'settings.read' : 'settings.update';
  }

  if (pathname === '/terminal/exec') return 'terminal.execute';
  if (pathname === '/terminal/sessions' || pathname === '/terminal/output' || pathname.startsWith('/terminal/') && upperMethod === 'GET') return 'terminal.read';
  if (pathname.endsWith('/write')) return 'terminal.write';
  if (pathname.endsWith('/kill')) return 'terminal.kill';
  if (pathname.endsWith('/restart')) return 'terminal.execute';

  if (pathname === '/tool-approvals') return 'toolApproval.read';
  if (pathname.startsWith('/tool-approvals/')) return upperMethod === 'GET' ? 'toolApproval.read' : 'toolApproval.decide';

  if (pathname === '/trace/sessions' || pathname.startsWith('/trace/')) return 'trace.read';

  if (pathname === '/workflows') return upperMethod === 'GET' ? 'workflow.read' : 'workflow.write';
  if (pathname.startsWith('/workflows/runs/') && (pathname.endsWith('/approve') || pathname.endsWith('/reject'))) return 'workflow.approve';
  if (pathname.startsWith('/workflows/runs/') && pathname.endsWith('/cancel')) return 'workflow.write';
  if (pathname.startsWith('/workflows/') && (pathname.endsWith('/rollback') || upperMethod === 'DELETE')) return 'workflow.write';
  if (pathname.startsWith('/workflows/')) return upperMethod === 'GET' ? 'workflow.read' : 'workflow.write';

  if (pathname === '/workspace/pick' || pathname === '/workspace/index') return 'workspace.switch';
  if (pathname === '/workspace/file') return upperMethod === 'PUT' ? 'workspace.write' : 'workspace.read';
  if (pathname.startsWith('/workspace/')) return 'workspace.read';

  return null;
}

function normalizePathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return rawUrl.split('?')[0]?.replace(/\/+$/, '') || '/';
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeProfile(value: string | undefined): LocalCapabilityProfile | undefined {
  if (value === 'local-user' || value === 'agent-runtime' || value === 'readonly') return value;
  return undefined;
}
