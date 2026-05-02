import fs from 'node:fs';
import path from 'node:path';

import type {
  CollaborationRole,
  CollaborationTeamId,
  CollaborationWorkflowDefinition,
  CollaborationWorkflowEdge,
  CollaborationWorkflowGraph,
  CollaborationWorkflowInput,
  CollaborationWorkflowNode,
  CollaborationWorkflowNodeType,
  WorkflowVersion,
} from '@ide/protocol';

const WORKFLOW_FILE_PATH = path.join('.ide', 'workflows.json');
const VALID_ROLES: CollaborationRole[] = [
  'planner',
  'context_curator',
  'coder',
  'reviewer',
  'verifier',
  'synthesizer',
];

const BUILTIN_WORKFLOWS: CollaborationWorkflowDefinition[] = [
  {
    id: 'multi-agent-research-assistant',
    name: 'Multi-Agent Research Assistant',
    description: 'Research, summarize, critique, and synthesize knowledge-heavy tasks.',
    roles: ['planner', 'context_curator', 'reviewer', 'synthesizer'],
    graph: graphFromRoles(['planner', 'context_curator', 'reviewer', 'synthesizer']),
    team: 'research_assistant',
    maxTokensPerRole: 1600,
    temperature: 0.2,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  },
  {
    id: 'ai-coding-team',
    name: 'AI Coding Team',
    description: 'Plan, gather context, code, review, verify, and synthesize full-stack changes.',
    roles: ['planner', 'context_curator', 'coder', 'reviewer', 'verifier', 'synthesizer'],
    graph: graphFromRoles(['planner', 'context_curator', 'coder', 'reviewer', 'verifier', 'synthesizer']),
    team: 'coding_team',
    maxTokensPerRole: 1800,
    temperature: 0.2,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  },
  {
    id: 'full-web-ui-agent-platform',
    name: 'Full Web UI Agent Platform',
    description: 'Use the complete manager-led workflow for app, backend, memory, trace, approval, and production work.',
    roles: ['planner', 'context_curator', 'coder', 'reviewer', 'verifier', 'synthesizer'],
    graph: graphFromRoles(['planner', 'context_curator', 'coder', 'reviewer', 'verifier', 'synthesizer'], true),
    team: 'coding_team',
    maxTokensPerRole: 2200,
    temperature: 0.18,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  },
];

interface WorkflowStoreOptions {
  workspaceRoot: string;
}

export class WorkflowStore {
  private workspaceRoot: string;

  constructor(options: WorkflowStoreOptions) {
    this.workspaceRoot = options.workspaceRoot;
  }

  setWorkspaceRoot(workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;
  }

  list(): CollaborationWorkflowDefinition[] {
    const custom = this.readWorkflows();
    const customIds = new Set(custom.map((workflow) => workflow.id));
    return [
      ...custom,
      ...BUILTIN_WORKFLOWS.filter((workflow) => !customIds.has(workflow.id)),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(workflowId: string): CollaborationWorkflowDefinition | null {
    return this.list().find((workflow) => workflow.id === workflowId) ?? null;
  }

  save(input: CollaborationWorkflowInput): CollaborationWorkflowDefinition {
    if (!this.workspaceRoot) {
      throw new Error('Workspace root is required before saving workflows');
    }

    const name = input.name.trim();
    if (!name) {
      throw new Error('Workflow name is required');
    }

    const roles = normalizeRoles(input.roles);
    if (!roles.length) {
      throw new Error('Workflow must include at least one valid role');
    }

    const graph = normalizeGraph(input.graph, roles);
    const now = new Date().toISOString();
    const workflows = this.readWorkflows();
    const id = normalizeWorkflowId(input.id ?? name);
    const existing = workflows.find((workflow) => workflow.id === id);

    // ─── Version tracking ─────────────────────────────
    const prevVersions: WorkflowVersion[] = existing?.versions ?? [];
    const nextVersionNum = (existing?.currentVersion ?? 0) + 1;
    const newVersion: WorkflowVersion = {
      version: nextVersionNum,
      graph: structuredClone(graph),
      createdAt: now,
      description: input.description?.trim() ?? `v${nextVersionNum}`,
    };
    // Keep at most 20 versions to prevent unbounded growth
    const versions = [...prevVersions, newVersion].slice(-20);

    const next: CollaborationWorkflowDefinition = {
      id,
      name,
      description: input.description?.trim() ?? '',
      roles,
      graph,
      team: normalizeTeam(input.team),
      maxTokensPerRole: normalizePositiveNumber(input.maxTokensPerRole),
      temperature: normalizeTemperature(input.temperature),
      versions,
      currentVersion: nextVersionNum,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.writeWorkflows([
      next,
      ...workflows.filter((workflow) => workflow.id !== id),
    ]);

    return next;
  }

  delete(workflowId: string): void {
    if (!this.workspaceRoot) {
      throw new Error('Workspace root is required before deleting workflows');
    }
    const workflows = this.readWorkflows();
    const filtered = workflows.filter((workflow) => workflow.id !== workflowId);
    if (filtered.length === workflows.length) {
      throw new Error(`Workflow '${workflowId}' not found`);
    }
    this.writeWorkflows(filtered);
  }

  getVersions(workflowId: string): WorkflowVersion[] {
    const workflow = this.get(workflowId);
    return workflow?.versions ?? [];
  }

  rollback(workflowId: string, targetVersion: number): CollaborationWorkflowDefinition {
    if (!this.workspaceRoot) {
      throw new Error('Workspace root is required before rolling back');
    }
    const workflows = this.readWorkflows();
    const idx = workflows.findIndex((w) => w.id === workflowId);
    if (idx === -1) throw new Error(`Workflow '${workflowId}' not found`);

    const workflow = workflows[idx];
    const version = workflow.versions?.find((v) => v.version === targetVersion);
    if (!version) throw new Error(`Version ${targetVersion} not found for '${workflowId}'`);

    const now = new Date().toISOString();
    const nextVersionNum = (workflow.currentVersion ?? 0) + 1;
    const rollbackVersion: WorkflowVersion = {
      version: nextVersionNum,
      graph: structuredClone(version.graph),
      createdAt: now,
      description: `Rollback to v${targetVersion}`,
    };

    const updated: CollaborationWorkflowDefinition = {
      ...workflow,
      graph: structuredClone(version.graph),
      versions: [...(workflow.versions ?? []), rollbackVersion].slice(-20),
      currentVersion: nextVersionNum,
      updatedAt: now,
    };

    workflows[idx] = updated;
    this.writeWorkflows(workflows);
    return updated;
  }

  private get workflowPath(): string {
    return path.join(this.workspaceRoot, WORKFLOW_FILE_PATH);
  }

  private readWorkflows(): CollaborationWorkflowDefinition[] {
    if (!this.workspaceRoot || !fs.existsSync(this.workflowPath)) {
      return [];
    }

    const raw = fs.readFileSync(this.workflowPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isWorkflowDefinition).map((workflow) => ({
      ...workflow,
      graph: normalizeGraph(workflow.graph, workflow.roles),
    }));
  }

  private writeWorkflows(workflows: CollaborationWorkflowDefinition[]): void {
    const target = this.workflowPath;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(workflows, null, 2)}\n`, 'utf8');
  }
}

function normalizeRoles(roles: CollaborationRole[]): CollaborationRole[] {
  const selected = roles.filter((role): role is CollaborationRole => VALID_ROLES.includes(role));
  const deduped = [...new Set(selected)];
  if (deduped.length > 0 && !deduped.includes('synthesizer')) {
    deduped.push('synthesizer');
  }
  return deduped;
}

function graphFromRoles(roles: CollaborationRole[], includeApproval = false): CollaborationWorkflowGraph {
  const columns: Record<CollaborationRole, number> = {
    planner: 0,
    context_curator: 0,
    coder: 1,
    reviewer: 2,
    verifier: 2,
    synthesizer: 3,
  };
  const rows: Record<CollaborationRole, number> = {
    planner: 0,
    context_curator: 1,
    coder: 0,
    reviewer: 0,
    verifier: 1,
    synthesizer: 0,
  };
  const nodes: CollaborationWorkflowNode[] = roles.map((role) => ({
    id: `node-${role}`,
    type: role === 'synthesizer' ? 'synthesizer' : 'agent',
    label: labelRole(role),
    role,
    agentId: defaultAgentIdForRole(role),
    position: {
      x: 24 + columns[role] * 190,
      y: 24 + rows[role] * 96,
    },
  }));

  if (includeApproval) {
    nodes.push({
      id: 'node-human-approval',
      type: 'approval',
      label: 'Human Approval',
      position: { x: 24 + 3 * 190, y: 24 + 96 },
      config: { requiredFor: ['patch', 'deploy', 'external_write'] },
    });
  }

  const has = (role: CollaborationRole) => roles.includes(role);
  const edges: CollaborationWorkflowEdge[] = [];
  const addEdge = (source: string, target: string, label?: string) => {
    if (nodes.some((node) => node.id === source) && nodes.some((node) => node.id === target)) {
      edges.push({ id: `edge-${source}-${target}`, source, target, label });
    }
  };

  if (has('planner') && has('coder')) addEdge('node-planner', 'node-coder', 'plan');
  if (has('context_curator') && has('coder')) addEdge('node-context_curator', 'node-coder', 'context');
  if (has('coder') && has('reviewer')) addEdge('node-coder', 'node-reviewer', 'review');
  if (has('coder') && has('verifier')) addEdge('node-coder', 'node-verifier', 'verify');
  if (has('reviewer') && has('synthesizer')) addEdge('node-reviewer', 'node-synthesizer', 'findings');
  if (has('verifier') && has('synthesizer')) addEdge('node-verifier', 'node-synthesizer', 'validation');
  if (includeApproval) addEdge('node-synthesizer', 'node-human-approval', 'approval gate');

  return { version: 1, nodes, edges };
}

function normalizeGraph(
  graph: CollaborationWorkflowGraph | undefined,
  roles: CollaborationRole[],
): CollaborationWorkflowGraph {
  if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return graphFromRoles(roles);
  }

  const nodes = graph.nodes
    .filter(isWorkflowNode)
    .map((node) => ({
      ...node,
      label: node.label.trim() || labelRole(node.role ?? 'planner'),
      agentId: node.agentId?.trim() || (node.role ? defaultAgentIdForRole(node.role) : undefined),
      position: {
        x: Number.isFinite(node.position.x) ? node.position.x : 0,
        y: Number.isFinite(node.position.y) ? node.position.y : 0,
      },
    }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => (
    isWorkflowEdge(edge) && nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target
  ));

  return nodes.length ? { version: 1, nodes, edges } : graphFromRoles(roles);
}

function isWorkflowNode(value: unknown): value is CollaborationWorkflowNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Partial<CollaborationWorkflowNode>;
  return (
    typeof node.id === 'string' &&
    isWorkflowNodeType(node.type) &&
    typeof node.label === 'string' &&
    (!node.role || VALID_ROLES.includes(node.role)) &&
    typeof node.position === 'object' &&
    node.position !== null &&
    typeof node.position.x === 'number' &&
    typeof node.position.y === 'number'
  );
}

function isWorkflowEdge(value: unknown): value is CollaborationWorkflowEdge {
  if (!value || typeof value !== 'object') return false;
  const edge = value as Partial<CollaborationWorkflowEdge>;
  return typeof edge.id === 'string' && typeof edge.source === 'string' && typeof edge.target === 'string';
}

function isWorkflowNodeType(value: unknown): value is CollaborationWorkflowNodeType {
  return (
    value === 'agent' ||
    value === 'tool' ||
    value === 'approval' ||
    value === 'condition' ||
    value === 'memory' ||
    value === 'synthesizer' ||
    value === 'start' ||
    value === 'end' ||
    value === 'retry'
  );
}

function defaultAgentIdForRole(role: CollaborationRole): string {
  switch (role) {
    case 'planner':
      return 'product-manager';
    case 'context_curator':
      return 'explore';
    case 'coder':
      return 'frontend-developer';
    case 'reviewer':
      return 'reviewer';
    case 'verifier':
      return 'tester';
    case 'synthesizer':
      return 'product-manager';
  }
}

function labelRole(role: CollaborationRole): string {
  return role
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function normalizeWorkflowId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) {
    throw new Error('Workflow id is required');
  }
  return id;
}

function normalizeTeam(team: CollaborationTeamId | undefined): CollaborationTeamId | undefined {
  if (!team || team === 'auto') return team;
  return team;
}

function normalizePositiveNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeTemperature(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(2, Math.max(0, value));
}

function isWorkflowDefinition(value: unknown): value is CollaborationWorkflowDefinition {
  if (!value || typeof value !== 'object') return false;
  const workflow = value as Partial<CollaborationWorkflowDefinition>;
  return (
    typeof workflow.id === 'string' &&
    typeof workflow.name === 'string' &&
    Array.isArray(workflow.roles) &&
    workflow.roles.every((role) => VALID_ROLES.includes(role)) &&
    typeof workflow.createdAt === 'string' &&
    typeof workflow.updatedAt === 'string'
  );
}
