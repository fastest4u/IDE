import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgentDefinition,
  AgentDefinitionInput,
  AIDiagnosticSummary,
  CollaborationResponse,
  CollaborationRole,
  CollaborationWorkflowDefinition,
  CollaborationWorkflowEdge,
  CollaborationWorkflowGraph,
  CollaborationWorkflowInput,
  CollaborationWorkflowNode,
  CollaborationWorkflowNodeType,
  IDESettings,
  LocalProviderSettings,
  PatchRecord,
  ProviderId,
  ProviderRuntimeStatus,
} from '@ide/protocol';

import './styles.css';

import {
  indexWorkspace,
  listAgents,
  listWorkflows,
  listTraces,
  activateAgent,
  approvePatch,
  applyPatch,
  listPatches,
  rejectPatch,
  reviewPatch,
  runCollaboration,
  saveAgent,
  saveWorkflow,
  getWorkspaceFile,
  getWorkspaceSummary,
  getSettings,
  listWorkspaceFiles,
  saveWorkspaceFile,
  getProviderRuntimeStatus,
  getObsidianMemoryStats,
  testProviderConnection,
  updateLocalProvider,
  updateSettings,
  searchObsidianMemory,
  type ObsidianNoteSummary,
  type ObsidianMemoryStatsResponse,
  type SessionTrace,
} from './services/model-gateway';
import { Terminal, useTerminalOutput } from './components/terminal';
import { WorkspaceSelector } from './components/workspace-selector';
import { ProviderSettingsPanel, providerTitle } from './components/ProviderSettings';
import {
  getMonacoCompilerOptions,
  getMonacoLanguage,
  getMonacoModelPath,
  isMonacoWorkspaceFile,
  syncMonacoWorkspace,
  type MonacoWorkspaceDocuments,
} from './lib/monaco-workspace';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  warnings?: string[];
  toolCalls?: string[];
}

type WorkspacePresence = 'ready' | 'missing' | 'error';
interface WorkspaceViewState {
  name: string;
  summary: string;
  files: string[];
  status: 'connected' | 'not indexed';
  ready: boolean;
  activeFilePath?: string;
  diagnostics: AIDiagnosticSummary[];
  rootDir: string | null;
}

interface EditorState {
  filePath: string;
  draft: string;
  saved: string;
}

interface OpenTab {
  id: string;
  filePath: string;
}

function useWorkspaceQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['workspace', 'active'],
    queryFn: async (): Promise<WorkspaceViewState> => {
      const [summary, files] = await Promise.all([getWorkspaceSummary(), listWorkspaceFiles()]);
      return {
        name: summary.name,
        summary: summary.summary,
        files: files.files,
        status: summary.ready ? 'connected' : 'not indexed',
        ready: summary.ready,
        activeFilePath: files.files[0],
        diagnostics: [],
        rootDir: summary.rootDir,
      };
    },
    enabled,
    retry: false,
    staleTime: 5_000,
  });
}

function useWorkspaceFileQuery(filePath: string) {
  return useQuery({
    queryKey: ['workspace-file', filePath],
    queryFn: () => getWorkspaceFile(filePath),
    enabled: filePath.length > 0,
    retry: false,
  });
}

function useSaveWorkspaceFileMutation() {
  return useMutation({
    mutationFn: async ({ filePath, content, expectedContent }: { filePath: string; content: string; expectedContent?: string }) =>
      saveWorkspaceFile(filePath, content, expectedContent),
  });
}

function getEditorLanguage(filePath: string): string {
  if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) return 'typescript';
  if (filePath.endsWith('.jsx') || filePath.endsWith('.js')) return 'javascript';
  if (filePath.endsWith('.json')) return 'json';
  if (filePath.endsWith('.css')) return 'css';
  if (filePath.endsWith('.md') || filePath.endsWith('.mdx')) return 'markdown';
  if (filePath.endsWith('.html')) return 'html';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml';
  return 'plaintext';
}

const MAX_MONACO_WORKSPACE_FILES = 120;
const MONACO_DOCUMENT_BATCH_SIZE = 8;

function useMonacoWorkspaceDocumentsQuery(enabled: boolean, workspaceFiles: string[], activeFile: string) {
  const monacoWorkspaceFiles = useMemo(() => {
    const candidates = workspaceFiles.filter(isMonacoWorkspaceFile);
    if (activeFile && isMonacoWorkspaceFile(activeFile)) {
      return [activeFile, ...candidates.filter((filePath) => filePath !== activeFile)].slice(0, MAX_MONACO_WORKSPACE_FILES);
    }
    return candidates.slice(0, MAX_MONACO_WORKSPACE_FILES);
  }, [activeFile, workspaceFiles]);

  const query = useQuery({
    queryKey: ['workspace', 'monaco-documents', monacoWorkspaceFiles],
    queryFn: async (): Promise<MonacoWorkspaceDocuments> => {
      const documents: Array<readonly [string, string]> = [];
      for (let index = 0; index < monacoWorkspaceFiles.length; index += MONACO_DOCUMENT_BATCH_SIZE) {
        const batch = monacoWorkspaceFiles.slice(index, index + MONACO_DOCUMENT_BATCH_SIZE);
        const batchDocuments = await Promise.all(
          batch.map(async (filePath) => {
            try {
              const file = await getWorkspaceFile(filePath);
              return [filePath, file.content] as const;
            } catch {
              return null;
            }
          }),
        );
        documents.push(...batchDocuments.filter((entry): entry is readonly [string, string] => entry !== null));
      }

      return Object.fromEntries(documents);
    },
    enabled: enabled && monacoWorkspaceFiles.length > 0,
    retry: false,
    staleTime: 15_000,
  });

  return { monacoWorkspaceFiles, ...query };
}

function usePatchesQuery() {
  return useQuery({
    queryKey: ['patches'],
    queryFn: listPatches,
    staleTime: 5_000,
  });
}

function useTracesQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['trace', 'sessions'],
    queryFn: listTraces,
    enabled,
    staleTime: 5_000,
    refetchInterval: enabled ? 5_000 : false,
  });
}

function useObsidianMemoryStatsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['memory', 'obsidian', 'stats'],
    queryFn: getObsidianMemoryStats,
    enabled,
    staleTime: 10_000,
  });
}

function useWorkflowsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: listWorkflows,
    enabled,
    staleTime: 5_000,
  });
}

function useProviderRuntimeStatusQuery() {
  return useQuery({
    queryKey: ['settings', 'provider-status'],
    queryFn: getProviderRuntimeStatus,
    staleTime: 10_000,
    retry: false,
  });
}

function useSettingsQuery(enabled: boolean) {
  return useQuery({
    queryKey: ['settings', 'local'],
    queryFn: getSettings,
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

function useUpdateSettingsMutation() {
  return useMutation({
    mutationFn: updateSettings,
  });
}

function useUpdateLocalProviderMutation() {
  return useMutation({
    mutationFn: ({ providerId, provider }: { providerId: ProviderId; provider: LocalProviderSettings }) =>
      updateLocalProvider(providerId, provider as unknown as Record<string, unknown>),
  });
}

interface FileTreeNode {
  id: string;
  kind: 'directory' | 'file';
  name: string;
  path: string;
  children: FileTreeNode[];
}

interface MaterialIconDescriptor {
  kind: 'folder' | 'file';
  iconName: string;
  openIconName?: string;
}

const EXPLORER_ROOT_ID = '__workspace-root__';
const MATERIAL_ICON_BASE_PATH = '/material-icons';

function getBasename(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? filePath;
}

function getFolderIconDescriptor(name: string, isRoot: boolean): MaterialIconDescriptor {
  const normalizedName = name.toLowerCase();

  if (isRoot) {
    return { kind: 'folder', iconName: 'folder-root', openIconName: 'folder-root-open' };
  }

  switch (normalizedName) {
    case 'apps':
      return { kind: 'folder', iconName: 'folder-app', openIconName: 'folder-app-open' };
    case 'docs':
      return { kind: 'folder', iconName: 'folder-docs', openIconName: 'folder-docs-open' };
    case 'packages':
      return { kind: 'folder', iconName: 'folder-packages', openIconName: 'folder-packages-open' };
    case 'scripts':
      return { kind: 'folder', iconName: 'folder-scripts', openIconName: 'folder-scripts-open' };
    case 'services':
      return { kind: 'folder', iconName: 'folder-controller', openIconName: 'folder-controller-open' };
    case 'src':
      return { kind: 'folder', iconName: 'folder-src', openIconName: 'folder-src-open' };
    case 'config':
      return { kind: 'folder', iconName: 'folder-config', openIconName: 'folder-config-open' };
    case '.github':
      return { kind: 'folder', iconName: 'folder-github', openIconName: 'folder-github-open' };
    case '.obsidian':
      return { kind: 'folder', iconName: 'folder-obsidian', openIconName: 'folder-obsidian-open' };
    case '.turbo':
      return { kind: 'folder', iconName: 'folder-turborepo', openIconName: 'folder-turborepo-open' };
    case 'routes':
      return { kind: 'folder', iconName: 'folder-routes', openIconName: 'folder-routes-open' };
    case 'components':
      return { kind: 'folder', iconName: 'folder-components', openIconName: 'folder-components-open' };
    case 'hooks':
      return { kind: 'folder', iconName: 'folder-hook', openIconName: 'folder-hook-open' };
    case 'lib':
      return { kind: 'folder', iconName: 'folder-lib', openIconName: 'folder-lib-open' };
    case 'db':
      return { kind: 'folder', iconName: 'folder-database', openIconName: 'folder-database-open' };
    case 'controllers':
      return { kind: 'folder', iconName: 'folder-controller', openIconName: 'folder-controller-open' };
    default:
      return { kind: 'folder', iconName: 'folder', openIconName: 'folder-open' };
  }
}

function getFileIconDescriptor(filePath: string): MaterialIconDescriptor {
  const basename = getBasename(filePath);
  const normalizedName = basename.toLowerCase();

  if (normalizedName === 'package.json') {
    return { kind: 'file', iconName: 'nodejs' };
  }

  if (normalizedName === 'pnpm-workspace.yaml' || normalizedName === 'pnpm-lock.yaml') {
    return { kind: 'file', iconName: 'pnpm' };
  }

  if (normalizedName === '.npmrc') {
    return { kind: 'file', iconName: 'npm' };
  }

  if (normalizedName === '.gitignore') {
    return { kind: 'file', iconName: 'git' };
  }

  if (normalizedName === 'readme.md') {
    return { kind: 'file', iconName: 'readme' };
  }

  if (normalizedName === 'claude.md') {
    return { kind: 'file', iconName: 'claude' };
  }

  if (normalizedName === 'agents.md') {
    return { kind: 'file', iconName: 'markdown' };
  }

  if (normalizedName === 'turbo.json') {
    return { kind: 'file', iconName: 'turborepo' };
  }

  if (normalizedName.startsWith('tsconfig')) {
    return { kind: 'file', iconName: 'tsconfig' };
  }

  if (normalizedName === 'vite.config.ts') {
    return { kind: 'file', iconName: 'vite' };
  }

  const extension = normalizedName.includes('.') ? normalizedName.slice(normalizedName.lastIndexOf('.')) : '';

  switch (extension) {
    case '.ts':
      return { kind: 'file', iconName: 'typescript' };
    case '.tsx':
      return { kind: 'file', iconName: 'react_ts' };
    case '.js':
    case '.cjs':
    case '.mjs':
      return { kind: 'file', iconName: 'javascript' };
    case '.jsx':
      return { kind: 'file', iconName: 'react' };
    case '.json':
      return { kind: 'file', iconName: 'json' };
    case '.yaml':
    case '.yml':
      return { kind: 'file', iconName: 'yaml' };
    case '.md':
    case '.mdx':
      return { kind: 'file', iconName: 'markdown' };
    case '.css':
      return { kind: 'file', iconName: 'css' };
    case '.html':
      return { kind: 'file', iconName: 'html' };
    default:
      return { kind: 'file', iconName: 'file' };
  }
}

function getMaterialIconSrc(iconName: string): string {
  return `${MATERIAL_ICON_BASE_PATH}/${iconName}.svg`;
}

function MaterialItemIcon({
  descriptor,
  expanded = false,
  className,
}: {
  descriptor: MaterialIconDescriptor;
  expanded?: boolean;
  className?: string;
}) {
  const iconName = descriptor.kind === 'folder' && expanded ? (descriptor.openIconName ?? descriptor.iconName) : descriptor.iconName;
  const iconClassName = [
    'app-shell__material-icon',
    `app-shell__material-icon--${descriptor.kind}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={iconClassName} aria-hidden="true">
      <img src={getMaterialIconSrc(iconName)} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

function buildFileTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const filePath of files) {
    const segments = filePath.split('/').filter(Boolean);
    let level = root;
    let cursor = '';

    for (const [index, segment] of segments.entries()) {
      cursor = cursor ? `${cursor}/${segment}` : segment;
      const kind: FileTreeNode['kind'] = index === segments.length - 1 ? 'file' : 'directory';
      let node = level.find((entry) => entry.name === segment && entry.kind === kind);

      if (!node) {
        node = { id: cursor, kind, name: segment, path: cursor, children: [] };
        level.push(node);
      }

      if (kind === 'directory') {
        level = node.children;
      }
    }
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === 'directory' ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .map((node) => ({ ...node, children: sortNodes(node.children) }));

  return sortNodes(root);
}

function ExplorerTree({
  nodes,
  activeFile,
  workspaceRoot,
  expandedDirectoryIds,
  onToggleDirectory,
  onOpenFile,
  depth = 0,
}: {
  nodes: FileTreeNode[];
  activeFile: string;
  workspaceRoot?: string;
  expandedDirectoryIds: ReadonlySet<string>;
  onToggleDirectory: (directoryId: string) => void;
  onOpenFile: (filePath: string) => void;
  depth?: number;
}) {
  if (!nodes.length) {
    return null;
  }

  return (
    <ul className={depth === 0 ? 'app-shell__tree' : 'app-shell__tree app-shell__tree--nested'}>
      {nodes.map((node) => {
        if (node.kind === 'directory') {
          const isExpanded = expandedDirectoryIds.has(node.id);
          const iconDescriptor = getFolderIconDescriptor(node.name, node.id === EXPLORER_ROOT_ID);
          return (
            <li key={node.id} className="app-shell__tree-item">
              <button
                type="button"
                className="app-shell__tree-branch"
                aria-expanded={isExpanded}
                onClick={() => onToggleDirectory(node.id)}
                style={{ ['--tree-depth' as string]: depth } as React.CSSProperties}
              >
                <span className="app-shell__tree-caret" />
                <MaterialItemIcon descriptor={iconDescriptor} expanded={isExpanded} className="app-shell__material-icon--tree" />
                <span>{node.name}</span>
              </button>
              {isExpanded && (
                <ExplorerTree
                  nodes={node.children}
                  activeFile={activeFile}
                  workspaceRoot={workspaceRoot}
                  expandedDirectoryIds={expandedDirectoryIds}
                  onToggleDirectory={onToggleDirectory}
                  onOpenFile={onOpenFile}
                  depth={depth + 1}
                />
              )}
            </li>
          );
        }

        const iconDescriptor = getFileIconDescriptor(node.path);
        return (
          <li key={node.id} className="app-shell__tree-item">
            <button
              type="button"
              className={node.path === activeFile ? 'app-shell__tree-file app-shell__tree-file--active' : 'app-shell__tree-file'}
              style={{ ['--tree-depth' as string]: depth } as React.CSSProperties}
              onClick={() => onOpenFile(node.path)}
            >
              <MaterialItemIcon descriptor={iconDescriptor} className="app-shell__material-icon--tree" />
              <span>{node.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const AGENT_PLATFORM_TABS = [
  'Dashboard',
  'Builder',
  'Tools',
  'Workflow',
  'Memory',
  'Trace',
  'Approvals',
  'Settings',
] as const;

type AgentPlatformTab = typeof AGENT_PLATFORM_TABS[number];

const WORKFLOW_ROLES: CollaborationRole[] = [
  'planner',
  'context_curator',
  'coder',
  'reviewer',
  'verifier',
  'synthesizer',
];

function defaultAgentIdForWorkflowRole(role: CollaborationRole): string {
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

function workflowRoleLabel(role: CollaborationRole): string {
  return role.replace('_', ' ');
}

function buildWorkflowGraph(roles: CollaborationRole[], includeApproval = false): CollaborationWorkflowGraph {
  const columnByRole: Record<CollaborationRole, number> = {
    planner: 0,
    context_curator: 0,
    coder: 1,
    reviewer: 2,
    verifier: 2,
    synthesizer: 3,
  };
  const rowByRole: Record<CollaborationRole, number> = {
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
    label: workflowRoleLabel(role),
    role,
    agentId: defaultAgentIdForWorkflowRole(role),
    position: { x: 18 + columnByRole[role] * 158, y: 18 + rowByRole[role] * 92 },
  }));

  if (includeApproval) {
    nodes.push({
      id: 'node-human-approval',
      type: 'approval',
      label: 'human approval',
      position: { x: 18 + 3 * 158, y: 18 + 92 },
      config: { requiredFor: ['patch', 'deploy', 'external_write'] },
    });
  }

  const hasNode = (id: string) => nodes.some((node) => node.id === id);
  const edges = [
    ['node-planner', 'node-coder', 'plan'],
    ['node-context_curator', 'node-coder', 'context'],
    ['node-coder', 'node-reviewer', 'review'],
    ['node-coder', 'node-verifier', 'verify'],
    ['node-reviewer', 'node-synthesizer', 'findings'],
    ['node-verifier', 'node-synthesizer', 'validation'],
    ['node-synthesizer', 'node-human-approval', 'approval'],
  ]
    .filter(([source, target]) => hasNode(source) && hasNode(target))
    .map(([source, target, label]) => ({
      id: `edge-${source}-${target}`,
      source,
      target,
      label,
    }));

  return { version: 1, nodes, edges };
}

function AgentManagerModal({
  agents,
  activeAgentId,
  providerStatuses,
  traces,
  patches,
  workspaceFiles,
  workspaceRoot,
  workspaceSummary,
  obsidianMemoryStats,
  obsidianSearchQuery,
  obsidianSearchResults,
  isSearchingObsidian,
  agentDraft,
  isSavingAgent,
  agentSaveError,
  workflows,
  selectedWorkflowId,
  workflowDraft,
  isSavingWorkflow,
  workflowSaveError,
  collaborationGoal,
  isRunningCollaboration,
  lastCollaboration,
  collaborationError,
  patchActionPendingId,
  onCollaborationGoalChange,
  onObsidianSearchQueryChange,
  onSearchObsidian,
  onAgentDraftChange,
  onSaveAgent,
  onSelectedWorkflowChange,
  onWorkflowDraftChange,
  onSaveWorkflow,
  onRunCollaboration,
  onReviewPatch,
  onApprovePatch,
  onRejectPatch,
  onApplyPatch,
  onClose,
}: {
  agents: AgentDefinition[];
  activeAgentId: string;
  providerStatuses: ProviderRuntimeStatus[];
  traces: SessionTrace[];
  patches: PatchRecord[];
  workspaceFiles: string[];
  workspaceRoot: string;
  workspaceSummary?: string;
  obsidianMemoryStats?: ObsidianMemoryStatsResponse;
  obsidianSearchQuery: string;
  obsidianSearchResults: ObsidianNoteSummary[];
  isSearchingObsidian: boolean;
  agentDraft: AgentDefinitionInput;
  isSavingAgent: boolean;
  agentSaveError: string | null;
  workflows: CollaborationWorkflowDefinition[];
  selectedWorkflowId: string;
  workflowDraft: CollaborationWorkflowInput;
  isSavingWorkflow: boolean;
  workflowSaveError: string | null;
  collaborationGoal: string;
  isRunningCollaboration: boolean;
  lastCollaboration: CollaborationResponse | null;
  collaborationError: string | null;
  patchActionPendingId: string | null;
  onCollaborationGoalChange: (goal: string) => void;
  onObsidianSearchQueryChange: (query: string) => void;
  onSearchObsidian: () => void;
  onAgentDraftChange: (draft: AgentDefinitionInput) => void;
  onSaveAgent: () => void;
  onSelectedWorkflowChange: (workflowId: string) => void;
  onWorkflowDraftChange: (draft: CollaborationWorkflowInput) => void;
  onSaveWorkflow: () => void;
  onRunCollaboration: () => void;
  onReviewPatch: (patchId: string) => void;
  onApprovePatch: (patchId: string) => void;
  onRejectPatch: (patchId: string) => void;
  onApplyPatch: (patchId: string) => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<AgentPlatformTab>('Dashboard');
  const [draggingWorkflowNode, setDraggingWorkflowNode] = useState<{
    nodeId: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [connectingEdge, setConnectingEdge] = useState<{ sourceId: string } | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const healthyProviders = providerStatuses.filter((provider) => provider.enabled && provider.healthy).length;
  const pendingPatches = patches.filter((patch) => patch.status === 'pending');
  const approvalPatches = patches.filter((patch) => patch.status === 'pending' || patch.status === 'approved');
  const latestTrace = traces[0];
  const executionWaves = (lastCollaboration?.metadata?.executionWaves as string[][] | undefined) ?? [
    ['planner', 'context_curator'],
    ['coder'],
    ['reviewer', 'verifier'],
    ['synthesizer'],
  ];
  const selectedTeamId = typeof lastCollaboration?.metadata?.teamId === 'string'
    ? lastCollaboration.metadata.teamId
    : 'auto';
  const selectedTeamReason = typeof lastCollaboration?.metadata?.teamReason === 'string'
    ? lastCollaboration.metadata.teamReason
    : 'Gateway will select the team for the next run.';
  const selectedWorkflow = workflows.find((workflow) => workflow.id === selectedWorkflowId);
  const workflowGraph = workflowDraft.graph ?? buildWorkflowGraph(workflowDraft.roles);
  const workflowGraphBounds = workflowGraph.nodes.reduce(
    (bounds, node) => ({
      width: Math.max(bounds.width, node.position.x + 180),
      height: Math.max(bounds.height, node.position.y + 80),
    }),
    { width: 700, height: 260 },
  );
  const updateWorkflowGraphNode = (nodeId: string, patch: Partial<CollaborationWorkflowNode>) => {
    onWorkflowDraftChange({
      ...workflowDraft,
      graph: {
        ...workflowGraph,
        nodes: workflowGraph.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
      },
    });
  };
  const setGraph = (graph: CollaborationWorkflowGraph) => onWorkflowDraftChange({ ...workflowDraft, graph });
  const addWorkflowNode = (type: CollaborationWorkflowNodeType) => {
    const maxX = workflowGraph.nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
    const maxY = workflowGraph.nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
    const id = `node-${type}-${Date.now()}`;
    const labels: Record<string, string> = { agent: 'New Agent', condition: 'Condition', retry: 'Retry', approval: 'Approval', synthesizer: 'Synthesizer', start: 'Start', end: 'End' };
    const newNode: CollaborationWorkflowNode = {
      id,
      type,
      label: labels[type] ?? type,
      position: { x: maxX + 180, y: Math.min(maxY, 200) },
      config: type === 'condition' ? { expression: "output.status === 'completed'", trueBranch: 'yes', falseBranch: 'no' }
        : type === 'retry' ? { maxAttempts: 3, delayMs: 1000 }
        : type === 'approval' ? { requiredFor: ['patch'] }
        : undefined,
    };
    setGraph({ ...workflowGraph, nodes: [...workflowGraph.nodes, newNode] });
  };
  const removeWorkflowNode = (nodeId: string) => {
    setGraph({
      ...workflowGraph,
      nodes: workflowGraph.nodes.filter((n) => n.id !== nodeId),
      edges: workflowGraph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    });
    setConnectingEdge(null);
    setSelectedEdgeId(null);
  };
  const removeWorkflowEdge = (edgeId: string) => {
    setGraph({ ...workflowGraph, edges: workflowGraph.edges.filter((e) => e.id !== edgeId) });
    setSelectedEdgeId(null);
  };
  const startEdgeConnection = (sourceId: string) => {
    setConnectingEdge({ sourceId });
  };
  const completeEdgeConnection = (targetId: string) => {
    if (!connectingEdge || connectingEdge.sourceId === targetId) { setConnectingEdge(null); return; }
    const exists = workflowGraph.edges.some((e) => e.source === connectingEdge.sourceId && e.target === targetId);
    if (!exists) {
      const newEdge: CollaborationWorkflowEdge = {
        id: `edge-${connectingEdge.sourceId}-${targetId}-${Date.now()}`,
        source: connectingEdge.sourceId,
        target: targetId,
      };
      setGraph({ ...workflowGraph, edges: [...workflowGraph.edges, newEdge] });
    }
    setConnectingEdge(null);
  };
  const handleWorkflowNodePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingWorkflowNode) return;
    const nextX = Math.max(8, draggingWorkflowNode.originX + event.clientX - draggingWorkflowNode.startX);
    const nextY = Math.max(8, draggingWorkflowNode.originY + event.clientY - draggingWorkflowNode.startY);
    updateWorkflowGraphNode(draggingWorkflowNode.nodeId, {
      position: {
        x: Math.round(nextX / 8) * 8,
        y: Math.round(nextY / 8) * 8,
      },
    });
  };
  const resetWorkflowGraph = () => {
    onWorkflowDraftChange({ ...workflowDraft, graph: buildWorkflowGraph(workflowDraft.roles) });
    setConnectingEdge(null);
    setSelectedEdgeId(null);
  };
  const toggleApprovalGate = () => {
    const hasApproval = workflowGraph.nodes.some((node) => node.type === 'approval');
    onWorkflowDraftChange({
      ...workflowDraft,
      graph: buildWorkflowGraph(workflowDraft.roles, !hasApproval),
    });
  };

  // ─── Runtime status polling ────────────────────────
  const activeRunId = typeof lastCollaboration?.metadata?.runId === 'string' ? lastCollaboration.metadata.runId : null;
  const [activeRunState, setActiveRunState] = useState<import('@ide/protocol').WorkflowRunState | null>(null);

  useEffect(() => {
    if (!activeRunId) { setActiveRunState(null); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const { getWorkflowRun } = await import('./services/model-gateway');
        const run = await getWorkflowRun(activeRunId);
        if (!cancelled) setActiveRunState(run);
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return;
        if (!cancelled) setTimeout(poll, 2000);
      } catch { /* gateway unreachable */ }
    };
    poll();
    return () => { cancelled = true; };
  }, [activeRunId]);

  const nodeStatusMap = new Map(
    activeRunState?.nodeStates.map((ns) => [ns.nodeId, ns.status]) ?? [],
  );

  const handleInlineApprove = async (nodeId: string) => {
    if (!activeRunId) return;
    try {
      const { approveWorkflowRun } = await import('./services/model-gateway');
      const run = await approveWorkflowRun(activeRunId, nodeId);
      setActiveRunState(run);
    } catch { /* handled by polling */ }
  };

  const handleInlineReject = async (nodeId: string) => {
    if (!activeRunId) return;
    try {
      const { rejectWorkflowRun } = await import('./services/model-gateway');
      const run = await rejectWorkflowRun(activeRunId, nodeId);
      setActiveRunState(run);
    } catch { /* handled by polling */ }
  };

  // ─── Trace popover (click node → view traces) ─────
  const [selectedNodeForTrace, setSelectedNodeForTrace] = useState<string | null>(null);
  const [nodeTraceSteps, setNodeTraceSteps] = useState<import('./services/model-gateway').NodeTraceStep[]>([]);

  const handleNodeDoubleClick = async (nodeId: string) => {
    setSelectedNodeForTrace(nodeId);
    try {
      const { getNodeTraceSteps } = await import('./services/model-gateway');
      const steps = await getNodeTraceSteps(nodeId);
      setNodeTraceSteps(steps);
    } catch {
      setNodeTraceSteps([]);
    }
  };

  const closeTracePopover = () => {
    setSelectedNodeForTrace(null);
    setNodeTraceSteps([]);
  };

  return (
    <div className="app-shell__modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="app-shell__agent-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-manager-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="app-shell__agent-manager-header">
          <div>
            <h2 id="agent-manager-title">Multi-Agent Developer</h2>
            <span>{workspaceRoot || 'No workspace selected'}</span>
          </div>
          <button type="button" className="app-shell__icon-button" aria-label="Close agent manager" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="app-shell__agent-manager-tabs" role="tablist" aria-label="Agent platform sections">
          {AGENT_PLATFORM_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={activeTab === tab ? 'app-shell__agent-manager-tab app-shell__agent-manager-tab--active' : 'app-shell__agent-manager-tab'}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="app-shell__agent-manager-body">
          {activeTab === 'Dashboard' && (
            <section className="app-shell__agent-dashboard">
              <div className="app-shell__metric-grid">
                <article><strong>{agents.length}</strong><span>Agents</span></article>
                <article><strong>{healthyProviders}</strong><span>Ready providers</span></article>
                <article><strong>{workspaceFiles.length}</strong><span>Indexed files</span></article>
                <article><strong>{pendingPatches.length}</strong><span>Approvals</span></article>
              </div>
              <div className="app-shell__manager-split">
                <section className="app-shell__manager-panel">
                  <h3>AI Coding Team</h3>
                  <div className="app-shell__agent-runner">
                    <textarea
                      value={collaborationGoal}
                      onChange={(event) => onCollaborationGoalChange(event.target.value)}
                      placeholder="Describe a product, coding, review, or research task for the agent team."
                      rows={4}
                    />
                    <select
                      className="app-shell__agent-omnibar-select app-shell__agent-omnibar-select--boxed"
                      value={selectedWorkflowId}
                      onChange={(event) => onSelectedWorkflowChange(event.target.value)}
                    >
                      <option value="">Auto workflow</option>
                      {workflows.map((workflow) => (
                        <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                      ))}
                    </select>
                    <button type="button" className="app-shell__connect-primary-button" onClick={onRunCollaboration} disabled={isRunningCollaboration}>
                      {isRunningCollaboration ? 'Running...' : 'Run Parallel Team'}
                    </button>
                  </div>
                  {collaborationError && <div className="app-shell__manager-error">{collaborationError}</div>}
                  {lastCollaboration && (
                    <div className="app-shell__collaboration-result">
                      <strong>{selectedTeamId}</strong>
                      <span>{selectedTeamReason}</span>
                      {selectedWorkflow && <span>Workflow: {selectedWorkflow.name}</span>}
                      <p>{lastCollaboration.finalOutput.summary}</p>
                    </div>
                  )}
                </section>
                <section className="app-shell__manager-panel">
                  <h3>Runtime</h3>
                  <div className="app-shell__runtime-list">
                    {agents.map((agent) => (
                      <article key={agent.id} className={agent.id === activeAgentId ? 'app-shell__runtime-row app-shell__runtime-row--active' : 'app-shell__runtime-row'}>
                        <strong>{agent.name}</strong>
                        <span>{agent.description}</span>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            </section>
          )}

          {activeTab === 'Builder' && (
            <section className="app-shell__manager-grid app-shell__manager-grid--wide-left">
              <article className="app-shell__manager-panel">
                <h3>Agent Builder</h3>
                <label>Name</label>
                <input
                  value={agentDraft.name}
                  onChange={(event) => onAgentDraftChange({ ...agentDraft, name: event.target.value })}
                  placeholder="Documentation Agent"
                />
                <label>Goal</label>
                <textarea
                  rows={3}
                  value={agentDraft.description}
                  onChange={(event) => onAgentDraftChange({ ...agentDraft, description: event.target.value })}
                  placeholder="Maintain project documentation and summarize implementation changes."
                />
                <label>Mode</label>
                <select
                  className="app-shell__agent-omnibar-select app-shell__agent-omnibar-select--boxed"
                  value={agentDraft.mode}
                  onChange={(event) => onAgentDraftChange({ ...agentDraft, mode: event.target.value as AgentDefinitionInput['mode'] })}
                >
                  <option value="plan">Plan</option>
                  <option value="explore">Explore</option>
                  <option value="build">Build</option>
                </select>
                <label>Instruction</label>
                <textarea
                  rows={6}
                  value={agentDraft.prompt ?? ''}
                  onChange={(event) => onAgentDraftChange({ ...agentDraft, prompt: event.target.value })}
                  placeholder="Write the agent system instruction..."
                />
                <label>Temperature</label>
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={agentDraft.temperature ?? 0.2}
                  onChange={(event) => onAgentDraftChange({ ...agentDraft, temperature: Number(event.target.value) })}
                />
                {agentSaveError && <div className="app-shell__manager-error">{agentSaveError}</div>}
                <button type="button" className="app-shell__connect-primary-button" onClick={onSaveAgent} disabled={isSavingAgent}>
                  {isSavingAgent ? 'Saving...' : 'Save Agent'}
                </button>
              </article>
              <section className="app-shell__runtime-list">
                {agents.map((agent) => (
                  <article key={agent.id} className="app-shell__runtime-row">
                    <strong>{agent.name}</strong>
                    <span>{agent.mode} - {agent.description}</span>
                  </article>
                ))}
              </section>
            </section>
          )}

          {activeTab === 'Tools' && (
            <section className="app-shell__manager-panel">
              <h3>Tool Manager</h3>
              <div className="app-shell__tool-matrix">
                {agents.map((agent) => (
                  <article key={agent.id}>
                    <strong>{agent.name}</strong>
                    {Object.entries(agent.permissions).map(([tool, permission]) => (
                      <span key={tool} className={`app-shell__permission-pill app-shell__permission-pill--${permission}`}>
                        {tool}: {permission}
                      </span>
                    ))}
                  </article>
                ))}
              </div>
            </section>
          )}

          {activeTab === 'Workflow' && (
            <section className="app-shell__manager-grid app-shell__manager-grid--wide-left">
              <article className="app-shell__manager-panel">
                <h3>Workflow Builder</h3>
                <label>Name</label>
                <input
                  value={workflowDraft.name}
                  onChange={(event) => onWorkflowDraftChange({ ...workflowDraft, name: event.target.value })}
                  placeholder="AI Coding Team"
                />
                <label>Description</label>
                <textarea
                  rows={3}
                  value={workflowDraft.description ?? ''}
                  onChange={(event) => onWorkflowDraftChange({ ...workflowDraft, description: event.target.value })}
                  placeholder="Planner and context roles fan out before coding, review, verification, and synthesis."
                />
                <label>Roles</label>
                <div className="app-shell__workflow-role-picker">
                  {WORKFLOW_ROLES.map((role) => {
                    const checked = workflowDraft.roles.includes(role);
                    return (
                      <label key={role} className={checked ? 'app-shell__workflow-role app-shell__workflow-role--active' : 'app-shell__workflow-role'}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            const nextRoles = event.target.checked
                              ? [...workflowDraft.roles, role]
                              : workflowDraft.roles.filter((candidate) => candidate !== role);
                            onWorkflowDraftChange({
                              ...workflowDraft,
                              roles: nextRoles,
                              graph: buildWorkflowGraph(nextRoles, workflowGraph.nodes.some((node) => node.type === 'approval')),
                            });
                          }}
                        />
                        <span>{role.replace('_', ' ')}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="app-shell__workflow-graph-toolbar">
                  <span>{workflowGraph.nodes.length} nodes · {workflowGraph.edges.length} edges</span>
                  <div className="app-shell__workflow-add-nodes">
                    {(['agent', 'condition', 'retry', 'approval', 'synthesizer'] as const).map((t) => (
                      <button key={t} type="button" className="app-shell__workflow-add-btn" onClick={() => addWorkflowNode(t)}>
                        + {t}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={resetWorkflowGraph}>Reset</button>
                </div>
                {connectingEdge && (
                  <div className="app-shell__workflow-connect-hint">
                    🔗 Click an input port to connect from <strong>{connectingEdge.sourceId}</strong>
                    <button type="button" onClick={() => setConnectingEdge(null)}>Cancel</button>
                  </div>
                )}
                {selectedEdgeId && (
                  <div className="app-shell__workflow-connect-hint">
                    <button type="button" className="app-shell__workflow-edge-delete-btn" onClick={() => removeWorkflowEdge(selectedEdgeId)}>🗑 Delete selected edge</button>
                    <button type="button" onClick={() => setSelectedEdgeId(null)}>Cancel</button>
                  </div>
                )}
                <div
                  className={`app-shell__workflow-graph${connectingEdge ? ' app-shell__workflow-graph--connecting' : ''}`}
                  style={{ minHeight: Math.max(260, workflowGraphBounds.height + 40) }}
                  onPointerMove={handleWorkflowNodePointerMove}
                  onPointerUp={() => setDraggingWorkflowNode(null)}
                  onPointerCancel={() => setDraggingWorkflowNode(null)}
                  onClick={() => { setSelectedEdgeId(null); }}
                >
                  <svg
                    className="app-shell__workflow-graph-lines"
                    viewBox={`0 0 ${workflowGraphBounds.width} ${workflowGraphBounds.height}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    {workflowGraph.edges.map((edge) => {
                      const source = workflowGraph.nodes.find((node) => node.id === edge.source);
                      const target = workflowGraph.nodes.find((node) => node.id === edge.target);
                      if (!source || !target) return null;
                      const sourceX = source.position.x + 140;
                      const sourceY = source.position.y + 30;
                      const targetX = target.position.x;
                      const targetY = target.position.y + 30;
                      const midX = sourceX + Math.max(28, (targetX - sourceX) / 2);
                      const isSelected = selectedEdgeId === edge.id;
                      return (
                        <g key={edge.id}>
                          {/* Wider invisible hit area */}
                          <path
                            d={`M ${sourceX} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${targetX} ${targetY}`}
                            fill="none" stroke="transparent" strokeWidth="14" style={{ cursor: 'pointer' }}
                            onClick={(ev) => { ev.stopPropagation(); setSelectedEdgeId(edge.id); }}
                          />
                          <path
                            className={isSelected ? 'app-shell__workflow-edge--selected' : ''}
                            d={`M ${sourceX} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${targetX} ${targetY}`}
                            onClick={(ev) => { ev.stopPropagation(); setSelectedEdgeId(edge.id); }}
                          />
                          {edge.branch && (
                            <text x={(sourceX + targetX) / 2} y={(sourceY + targetY) / 2 - 6} className="app-shell__workflow-edge-label">
                              {edge.branch === 'true' ? '✓' : edge.branch === 'false' ? '✗' : edge.branch}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                  {workflowGraph.nodes.map((node) => {
                    const nodeStatus = nodeStatusMap.get(node.id);
                    const statusClass = nodeStatus ? ` app-shell__workflow-node--status-${nodeStatus}` : '';
                    return (
                    <article
                      key={node.id}
                      className={`app-shell__workflow-node app-shell__workflow-node--${node.type}${connectingEdge ? ' app-shell__workflow-node--connectable' : ''}${statusClass}`}
                      style={{ left: node.position.x, top: node.position.y }}
                      onPointerDown={(event) => {
                        if (event.button !== 0 || connectingEdge) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDraggingWorkflowNode({
                          nodeId: node.id,
                          startX: event.clientX,
                          startY: event.clientY,
                          originX: node.position.x,
                          originY: node.position.y,
                        });
                      }}
                      onClick={() => { if (connectingEdge) completeEdgeConnection(node.id); }}
                      onDoubleClick={() => handleNodeDoubleClick(node.id)}
                    >
                      {/* Input port (left) */}
                      <span
                        className="app-shell__workflow-port app-shell__workflow-port--in"
                        title="Input port — click an output port first"
                        onClick={(ev) => { ev.stopPropagation(); if (connectingEdge) completeEdgeConnection(node.id); }}
                      />
                      <strong>{node.label}</strong>
                      <span className="app-shell__workflow-node-type">{node.type}</span>
                      {/* Runtime status badge */}
                      {nodeStatus && (
                        <span className={`app-shell__workflow-status-badge app-shell__workflow-status-badge--${nodeStatus}`}>
                          {nodeStatus === 'pending' && '⏳'}
                          {nodeStatus === 'running' && '⚡'}
                          {nodeStatus === 'completed' && '✅'}
                          {nodeStatus === 'failed' && '❌'}
                          {nodeStatus === 'skipped' && '⏭'}
                          {nodeStatus === 'waiting_approval' && '🔔'}
                          {nodeStatus === 'approved' && '✅'}
                          {nodeStatus === 'rejected' && '🚫'}
                          {nodeStatus === 'retrying' && '🔄'}
                        </span>
                      )}
                      {/* Output port (right) */}
                      <span
                        className="app-shell__workflow-port app-shell__workflow-port--out"
                        title="Click to start connecting an edge"
                        onClick={(ev) => { ev.stopPropagation(); startEdgeConnection(node.id); }}
                      />
                      {/* Delete button */}
                      <button
                        type="button"
                        className="app-shell__workflow-node-delete"
                        title="Remove node"
                        onPointerDown={(ev) => ev.stopPropagation()}
                        onClick={(ev) => { ev.stopPropagation(); removeWorkflowNode(node.id); }}
                      >×</button>
                      {node.role && (
                        <select
                          className="app-shell__agent-omnibar-select app-shell__agent-omnibar-select--boxed"
                          value={node.agentId ?? defaultAgentIdForWorkflowRole(node.role)}
                          onPointerDown={(event) => event.stopPropagation()}
                          onChange={(event) => updateWorkflowGraphNode(node.id, { agentId: event.target.value })}
                        >
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>{agent.name}</option>
                          ))}
                        </select>
                      )}
                      {node.type === 'condition' && (
                        <input
                          className="app-shell__workflow-node-config-input"
                          value={(node.config as any)?.expression ?? ''}
                          placeholder="output.status === 'completed'"
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onChange={(ev) => updateWorkflowGraphNode(node.id, { config: { ...node.config, expression: ev.target.value } })}
                        />
                      )}
                      {node.type === 'retry' && (
                        <span className="app-shell__workflow-node-badge">max {(node.config as any)?.maxAttempts ?? 3}</span>
                      )}
                      {/* Failure policy dropdown */}
                      {(node.type === 'agent' || node.type === 'tool' || node.type === 'memory' || node.type === 'synthesizer') && (
                        <select
                          className="app-shell__workflow-node-policy"
                          value={node.onFailure ?? 'stop'}
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onChange={(ev) => updateWorkflowGraphNode(node.id, { onFailure: ev.target.value as any })}
                          title="Failure policy"
                        >
                          <option value="stop">⛔ Stop</option>
                          <option value="skip">⏭ Skip</option>
                          <option value="retry">🔄 Retry</option>
                          <option value="fallback">🔀 Fallback</option>
                        </select>
                      )}
                      {/* Inline approval actions */}
                      {nodeStatus === 'waiting_approval' && (
                        <div className="app-shell__workflow-node-approval-actions">
                          <button type="button" className="app-shell__workflow-node-approval-btn app-shell__workflow-node-approval-btn--approve" onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); handleInlineApprove(node.id); }}>✅ Approve</button>
                          <button type="button" className="app-shell__workflow-node-approval-btn app-shell__workflow-node-approval-btn--reject" onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); handleInlineReject(node.id); }}>❌ Reject</button>
                        </div>
                      )}
                    </article>
                    );
                  })}
                </div>
                {/* Version badge */}
                {workflowDraft.id && (
                  <div className="app-shell__workflow-version-badge">
                    v{(workflowDraft as any).currentVersion ?? 1}
                  </div>
                )}
                {/* Trace popover */}
                {selectedNodeForTrace && (
                  <div className="app-shell__workflow-trace-popover">
                    <header>
                      <strong>Traces — {selectedNodeForTrace}</strong>
                      <button type="button" onClick={closeTracePopover}>×</button>
                    </header>
                    {nodeTraceSteps.length === 0 ? (
                      <p className="app-shell__workflow-trace-empty">No trace steps for this node yet. Run a workflow to generate traces.</p>
                    ) : (
                      <ul className="app-shell__workflow-trace-steps">
                        {nodeTraceSteps.map((step) => (
                          <li key={step.id}>
                            <span className="app-shell__workflow-trace-type">{step.type}</span>
                            <span className="app-shell__workflow-trace-time">{new Date(step.timestamp).toLocaleTimeString()}</span>
                            {step.durationMs != null && <span className="app-shell__workflow-trace-duration">{step.durationMs}ms</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="app-shell__workflow-field-row">
                  <label>
                    Tokens
                    <input
                      type="number"
                      min="256"
                      step="128"
                      value={workflowDraft.maxTokensPerRole ?? 1800}
                      onChange={(event) => onWorkflowDraftChange({ ...workflowDraft, maxTokensPerRole: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Temperature
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={workflowDraft.temperature ?? 0.2}
                      onChange={(event) => onWorkflowDraftChange({ ...workflowDraft, temperature: Number(event.target.value) })}
                    />
                  </label>
                </div>
                {workflowSaveError && <div className="app-shell__manager-error">{workflowSaveError}</div>}
                <button type="button" className="app-shell__connect-primary-button" onClick={onSaveWorkflow} disabled={isSavingWorkflow}>
                  {isSavingWorkflow ? 'Saving...' : 'Save Workflow'}
                </button>
              </article>

              <article className="app-shell__manager-panel">
                <h3>Saved Workflows</h3>
                <div className="app-shell__workflow-list">
                  <button
                    type="button"
                    className={selectedWorkflowId === '' ? 'app-shell__runtime-row app-shell__runtime-row--active' : 'app-shell__runtime-row'}
                    onClick={() => onSelectedWorkflowChange('')}
                  >
                    <strong>Auto workflow</strong>
                    <span>Gateway selects team and roles from task intent.</span>
                  </button>
                  {workflows.map((workflow) => (
                    <button
                      key={workflow.id}
                      type="button"
                      className={selectedWorkflowId === workflow.id ? 'app-shell__runtime-row app-shell__runtime-row--active' : 'app-shell__runtime-row'}
                      onClick={() => onSelectedWorkflowChange(workflow.id)}
                    >
                      <strong>{workflow.name}</strong>
                      <span>{workflow.roles.map((role) => role.replace('_', ' ')).join(' -> ')}</span>
                    </button>
                  ))}
                </div>
                <h3>Parallel Waves</h3>
                <div className="app-shell__workflow-waves">
                  {executionWaves.map((wave, index) => (
                    <article key={`${index}:${wave.join('-')}`}>
                      <span>Wave {index + 1}</span>
                      <div>{wave.map((role) => <strong key={role}>{role.replace('_', ' ')}</strong>)}</div>
                    </article>
                  ))}
                </div>
                {lastCollaboration && (
                  <div className="app-shell__role-output-list">
                  {lastCollaboration.outputs.map((output) => (
                    <article key={output.id}>
                      <strong>{output.specialistAgentName ?? output.role}</strong>
                      {output.specialistAgentName && <span>{output.role}</span>}
                      <span>{output.status}</span>
                      <p>{output.summary}</p>
                    </article>
                    ))}
                  </div>
                )}
              </article>
            </section>
          )}

          {activeTab === 'Memory' && (
            <section className="app-shell__manager-grid">
              <article className="app-shell__manager-panel">
                <h3>Obsidian Memory</h3>
                <div className="app-shell__metric-grid app-shell__metric-grid--compact">
                  <article><strong>{obsidianMemoryStats?.obsidian.total ?? 0}</strong><span>Notes</span></article>
                  <article><strong>{Object.keys(obsidianMemoryStats?.obsidian.byCategory ?? {}).length}</strong><span>Categories</span></article>
                  <article><strong>{obsidianMemoryStats?.obsidian.tags.length ?? 0}</strong><span>Tags</span></article>
                  <article><strong>{obsidianMemoryStats?.obsidian.ready ? 'On' : 'Off'}</strong><span>Vault</span></article>
                </div>
                <form className="app-shell__memory-search" onSubmit={(event) => { event.preventDefault(); onSearchObsidian(); }}>
                  <input
                    value={obsidianSearchQuery}
                    onChange={(event) => onObsidianSearchQueryChange(event.target.value)}
                    placeholder="Search Obsidian memory..."
                  />
                  <button type="submit" className="app-shell__connect-primary-button" disabled={isSearchingObsidian}>
                    Search
                  </button>
                </form>
                <div className="app-shell__memory-results">
                  {obsidianSearchResults.map((note) => (
                    <article key={note.path}>
                      <strong>{note.title}</strong>
                      <span>{note.path}</span>
                      <p>{note.excerpt}</p>
                    </article>
                  ))}
                </div>
              </article>
              <article className="app-shell__manager-panel">
                <h3>Prompt Retrieval</h3>
                <p>{workspaceSummary || 'Workspace summary is not available.'}</p>
                <div className="app-shell__connect-meta">
                  <span>source: Obsidian markdown</span>
                  <span>retrieval: lexical note search</span>
                  <span>writeback: agent session notes</span>
                  <span>path: docs/memory/agent-sessions</span>
                </div>
                {Boolean(lastCollaboration?.metadata?.obsidianMemoryPath) && (
                  <p>Last memory note: {String(lastCollaboration!.metadata!.obsidianMemoryPath)}</p>
                )}
              </article>
            </section>
          )}

          {activeTab === 'Trace' && (
            <section className="app-shell__manager-panel">
              <h3>Trace Viewer</h3>
              {!traces.length && <div className="app-shell__empty-list">No trace events recorded yet.</div>}
              <div className="app-shell__trace-list">
                {traces.map((trace) => (
                  <article key={trace.sessionId}>
                    <strong>{trace.sessionId}</strong>
                    <span>{trace.summary.totalSteps} steps · {trace.summary.totalTokens} tokens · {trace.summary.totalDurationMs}ms</span>
                    <div>
                      {trace.steps.slice(-10).map((step) => (
                        <code key={step.id} title={JSON.stringify(step.metadata)}>{step.agentId}:{step.type}</code>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              {latestTrace && <p>Latest run started {new Date(latestTrace.startedAt).toLocaleString()}.</p>}
            </section>
          )}

          {activeTab === 'Approvals' && (
            <section className="app-shell__manager-panel">
              <h3>Approval Queue</h3>
              {!approvalPatches.length && <div className="app-shell__empty-list">No risky action is waiting for approval.</div>}
              <div className="app-shell__approval-list">
                {approvalPatches.map((patch) => (
                  <article key={patch.id}>
                    <div className="app-shell__approval-row-head">
                      <strong>{patch.title}</strong>
                      <span>{patch.status}</span>
                    </div>
                    <p>{patch.summary}</p>
                    <div className="app-shell__approval-meta">
                      <span>{patch.operations.length} operations</span>
                      <span>{patch.review?.status ?? 'not reviewed'}</span>
                    </div>
                    <div className="app-shell__approval-actions">
                      <button type="button" className="app-shell__provider-connect-button" disabled={patchActionPendingId === patch.id} onClick={() => onReviewPatch(patch.id)}>Review</button>
                      {patch.status === 'pending' && (
                        <>
                          <button type="button" className="app-shell__connect-primary-button" disabled={patchActionPendingId === patch.id} onClick={() => onApprovePatch(patch.id)}>Approve</button>
                          <button type="button" className="app-shell__provider-connect-button" disabled={patchActionPendingId === patch.id} onClick={() => onRejectPatch(patch.id)}>Reject</button>
                        </>
                      )}
                      {patch.status === 'approved' && (
                        <button type="button" className="app-shell__connect-primary-button" disabled={patchActionPendingId === patch.id} onClick={() => onApplyPatch(patch.id)}>Apply</button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {activeTab === 'Settings' && (
            <section className="app-shell__manager-grid">
              <article className="app-shell__manager-panel">
                <h3>Providers</h3>
                {providerStatuses.map((provider) => (
                  <p key={provider.providerId}>{provider.providerId}: {provider.enabled ? provider.healthy ? 'ready' : 'unreachable' : 'disabled'}</p>
                ))}
              </article>
              <article className="app-shell__manager-panel">
                <h3>Production Controls</h3>
                <div className="app-shell__connect-meta">
                  <span>rate limit policy</span>
                  <span>model fallback</span>
                  <span>audit log</span>
                  <span>human approval</span>
                  <span>permission control</span>
                </div>
              </article>
            </section>
          )}
        </div>
      </section>
    </div>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { file?: string; workspace?: string };
  const requestedWorkspaceRoot = search.workspace ?? '';
  const hasExplicitWorkspaceSelection = requestedWorkspaceRoot.trim().length > 0;
  const workspaceQuery = useWorkspaceQuery(hasExplicitWorkspaceSelection);
  const patchesQuery = usePatchesQuery();
  const tracesQuery = useTracesQuery(hasExplicitWorkspaceSelection);
  const obsidianMemoryStatsQuery = useObsidianMemoryStatsQuery(hasExplicitWorkspaceSelection);
  const workflowsQuery = useWorkflowsQuery(hasExplicitWorkspaceSelection);
  const providerStatusQuery = useProviderRuntimeStatusQuery();
  const settingsQuery = useSettingsQuery(hasExplicitWorkspaceSelection);
  const queryClient = useQueryClient();
  const saveFileMutation = useSaveWorkspaceFileMutation();
  const updateSettingsMutation = useUpdateSettingsMutation();
  const updateLocalProviderMutation = useUpdateLocalProviderMutation();
  const collaborationMutation = useMutation({ mutationFn: runCollaboration });
  const patchActionMutation = useMutation({
    mutationFn: async ({ patchId, action }: { patchId: string; action: 'review' | 'approve' | 'reject' | 'apply' }) => {
      if (action === 'review') return reviewPatch(patchId);
      if (action === 'approve') return approvePatch(patchId);
      if (action === 'reject') return rejectPatch(patchId);
      return applyPatch(patchId);
    },
  });
  const obsidianSearchMutation = useMutation({ mutationFn: searchObsidianMemory });
  const saveAgentMutation = useMutation({ mutationFn: saveAgent });
  const saveWorkflowMutation = useMutation({ mutationFn: saveWorkflow });
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 'seed-assistant', role: 'assistant', content: 'สั่งงานได้เลย Gateway จะเลือกทีม agents และ orchestration ให้แบบอัตโนมัติ.' }]);
  const [editorSelection, setEditorSelection] = useState<{ text: string; filePath: string } | null>(null);
  const [editorState, setEditorState] = useState<EditorState>({ filePath: '', draft: '', saved: '' });
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(() => new Set([EXPLORER_ROOT_ID]));
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId | ''>('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const selectedMode = 'Auto Team';
  const [selectedAgentId, setSelectedAgentId] = useState('build');
  const [availableAgents, setAvailableAgents] = useState<AgentDefinition[]>([]);
  const [agentDraft, setAgentDraft] = useState<AgentDefinitionInput>({
    name: '',
    description: '',
    mode: 'plan',
    prompt: '',
    temperature: 0.2,
    selectable: true,
  });
  const [agentSaveError, setAgentSaveError] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [workflowDraft, setWorkflowDraft] = useState<CollaborationWorkflowInput>({
    name: '',
    description: '',
    roles: ['planner', 'context_curator', 'coder', 'reviewer', 'verifier', 'synthesizer'],
    graph: buildWorkflowGraph(['planner', 'context_curator', 'coder', 'reviewer', 'verifier', 'synthesizer']),
    team: 'auto',
    maxTokensPerRole: 1800,
    temperature: 0.2,
  });
  const [workflowSaveError, setWorkflowSaveError] = useState<string | null>(null);
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<'Default' | 'Low' | 'Medium' | 'High' | 'Max'>('High');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAgentManagerOpen, setIsAgentManagerOpen] = useState(false);
  const [collaborationGoal, setCollaborationGoal] = useState('Build an AI coding team plan for this workspace and identify the safest next implementation steps.');
  const [lastCollaboration, setLastCollaboration] = useState<CollaborationResponse | null>(null);
  const [collaborationError, setCollaborationError] = useState<string | null>(null);
  const [obsidianSearchQuery, setObsidianSearchQuery] = useState('');
  const [obsidianSearchResults, setObsidianSearchResults] = useState<ObsidianNoteSummary[]>([]);
  const [patchActionPendingId, setPatchActionPendingId] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState<ProviderId | null>(null);
  const [openTabsState, setOpenTabsState] = useState<OpenTab[]>([]);
  const workspaceSyncRef = useRef<string | null>(null);

  const terminalOutput = useTerminalOutput();

  const workspaceRoot = workspaceQuery.data?.rootDir || requestedWorkspaceRoot || '';
  const hasWorkspace = hasExplicitWorkspaceSelection && Boolean(workspaceRoot);
  const activeFile = hasWorkspace ? (search.file ?? openTabsState[openTabsState.length - 1]?.filePath ?? '') : '';
  const activeFileRef = useRef(activeFile);
  const workspaceFileQuery = useWorkspaceFileQuery(activeFile);

  useEffect(() => {
    activeFileRef.current = activeFile;
    setEditorSelection(null);
  }, [activeFile]);

  useEffect(() => {
    setExpandedDirectoryIds(new Set([EXPLORER_ROOT_ID]));
  }, [workspaceRoot]);

  useEffect(() => {
    if (!hasExplicitWorkspaceSelection || workspaceQuery.isLoading || workspaceQuery.isError || !workspaceQuery.data) {
      return;
    }

    const indexedRoot = workspaceQuery.data.rootDir;
    if (!requestedWorkspaceRoot || !indexedRoot || indexedRoot === requestedWorkspaceRoot) {
      return;
    }

    if (workspaceSyncRef.current === requestedWorkspaceRoot) {
      return;
    }

    workspaceSyncRef.current = requestedWorkspaceRoot;

    void indexWorkspace(requestedWorkspaceRoot)
      .then(async (result) => {
        workspaceSyncRef.current = null;
        if (result.rootDir !== requestedWorkspaceRoot) {
          navigate({ to: '/', search: { workspace: result.rootDir } });
        }
        await queryClient.invalidateQueries({ queryKey: ['workspace', 'active'] });
        await queryClient.invalidateQueries({ queryKey: ['workspace-file'] });
      })
      .catch(async () => {
        workspaceSyncRef.current = null;
        navigate({ to: '/', search: {} });
        await queryClient.invalidateQueries({ queryKey: ['workspace', 'active'] });
        await queryClient.invalidateQueries({ queryKey: ['workspace-file'] });
      });
  }, [
    hasExplicitWorkspaceSelection,
    navigate,
    queryClient,
    requestedWorkspaceRoot,
    workspaceQuery.data,
    workspaceQuery.isError,
    workspaceQuery.isLoading,
  ]);

  // Load available agents from model gateway
  useEffect(() => {
    listAgents()
      .then((data) => {
        setAvailableAgents(data.agents.filter((a) => a.selectable));
        if (data.activeAgentId) setSelectedAgentId(data.activeAgentId);
      })
      .catch(() => {});
  }, [hasWorkspace]);

  const handleSwitchAgent = async (agentId: string) => {
    try {
      const data = await activateAgent(agentId);
      setSelectedAgentId(data.activeAgentId);
    } catch {
      setSelectedAgentId(agentId);
    }
  };

  useEffect(() => {
    const loadedFile = workspaceFileQuery.data;
    if (!activeFile || !loadedFile) return;
    setEditorState((current) => {
      if (current.filePath === activeFile && current.saved === loadedFile.content) return current;
      if (current.filePath === activeFile && current.draft !== current.saved) return current;
      return { filePath: activeFile, draft: loadedFile.content, saved: loadedFile.content };
    });
  }, [activeFile, workspaceFileQuery.data]);

  const editorDraft = editorState.filePath === activeFile ? editorState.draft : '';
  const savedContent = editorState.filePath === activeFile ? editorState.saved : '';
  const isDirty = editorState.filePath === activeFile && editorDraft !== savedContent;
  const selectedText = editorSelection?.filePath === activeFile ? editorSelection.text : '';
  const activeFilePath = activeFile || 'No file selected';
  const gitDiff = '';
  const diagnostics = workspaceQuery.data?.diagnostics ?? [];
  const patchCards = patchesQuery.data ?? [];
  const traces = tracesQuery.data ?? [];
  const providerStatuses = providerStatusQuery.data?.providers ?? [];
  const workspaceFiles = workspaceQuery.data?.files ?? [];
  const obsidianMemoryStats = obsidianMemoryStatsQuery.data;
  const workflows = workflowsQuery.data?.workflows ?? [];
  const selectedWorkflowForRun = workflows.find((workflow) => workflow.id === selectedWorkflowId);

  const monacoWorkspaceDocumentsQuery = useMonacoWorkspaceDocumentsQuery(hasWorkspace, workspaceFiles, activeFile);
  const workspaceName = workspaceQuery.data?.name ?? 'workspace';
  const workspacePresence: WorkspacePresence = workspaceQuery.isError ? 'error' : workspaceQuery.data?.ready ? 'ready' : 'missing';
  const shouldShowWelcome = !hasExplicitWorkspaceSelection;
  const fileStatus = !activeFile ? 'No file selected' : workspaceFileQuery.isLoading ? 'Loading file' : workspaceFileQuery.isError ? 'File unavailable' : isDirty ? 'Unsaved changes' : 'Saved';
  const healthyProviders = providerStatuses.filter((provider) => provider.enabled && provider.healthy).length;
  const visibleWorkspaceName = workspaceName || 'workspace';
  const fileTree = useMemo(() => buildFileTree(workspaceFiles), [workspaceFiles]);
  const explorerNodes = useMemo<FileTreeNode[]>(() => {
    if (!workspaceFiles.length) {
      return [];
    }

    return [
      {
        id: EXPLORER_ROOT_ID,
        kind: 'directory',
        name: visibleWorkspaceName,
        path: '',
        children: fileTree,
      },
    ];
  }, [fileTree, visibleWorkspaceName, workspaceFiles.length]);

  const openTabs = useMemo(
    () => openTabsState.filter((tab) => tab.filePath && workspaceFiles.includes(tab.filePath)),
    [openTabsState, workspaceFiles],
  );
  const currentTabName = activeFile ? activeFile.split('/').pop() ?? activeFile : 'No file selected';
  const breadcrumbSegments = activeFile ? activeFile.split('/') : [];
  const openTabForFile = useCallback((filePath: string) => {
    if (!filePath) return;
    setOpenTabsState((current) => {
      const existing = current.find((tab) => tab.filePath === filePath);
      if (existing) return current;
      const tabId = crypto.randomUUID();
      return [...current, { id: tabId, filePath }];
    });
    navigate({ to: '/', search: { workspace: workspaceRoot || undefined, file: filePath } });
  }, [navigate, workspaceRoot]);

  const closeTab = useCallback((tabId: string) => {
    setOpenTabsState((current) => {
      const nextTabs = current.filter((tab) => tab.id !== tabId);
      const closedTab = current.find((tab) => tab.id === tabId);
      const nextActiveFile = closedTab && activeFile === closedTab.filePath ? nextTabs[nextTabs.length - 1]?.filePath ?? '' : activeFile;

      const nextSearch = { workspace: workspaceRoot || undefined, ...(nextActiveFile ? { file: nextActiveFile } : {}) };
      navigate({ to: '/', search: nextSearch });
      void queryClient.invalidateQueries({ queryKey: ['workspace-file'] });

      return nextTabs;
    });
  }, [activeFile, navigate, queryClient, workspaceRoot]);
  const readyProviders = providerStatuses.filter((provider) => provider.enabled && provider.healthy && provider.models.length > 0);
  const activeProvider = readyProviders.find((provider) => provider.providerId === selectedProviderId) ?? readyProviders[0];
  const availableModels = activeProvider?.models ?? [];
  const activeModel = availableModels.find((model) => model.modelId === selectedModelId) ?? availableModels[0];
  const activeModelId = activeModel?.modelId ?? 'No model';
  const primaryProvider = activeProvider?.providerId ?? 'offline';
  const monacoEditorPath = hasWorkspace && activeFile ? getMonacoModelPath(workspaceRoot, activeFile) : 'file:///untitled';

  useEffect(() => {
    if (!activeProvider) {
      if (selectedProviderId || selectedModelId) {
        setSelectedProviderId('');
        setSelectedModelId('');
      }
      return;
    }

    if (selectedProviderId !== activeProvider.providerId) {
      setSelectedProviderId(activeProvider.providerId);
    }

    if (!selectedModelId || !availableModels.some((model) => model.modelId === selectedModelId)) {
      setSelectedModelId(availableModels[0].modelId);
    }
  }, [activeProvider, availableModels, selectedModelId, selectedProviderId]);

  useEffect(() => {
    if (!hasWorkspace || !workspaceRoot) {
      return;
    }

    let cancelled = false;
    void loader.init().then((monaco) => {
      if (cancelled) {
        return;
      }

      if (!monacoWorkspaceDocumentsQuery.data) {
        const compilerOptions = getMonacoCompilerOptions(monaco, workspaceRoot, activeFile, {});
        monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
        monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
        monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
        return;
      }

      syncMonacoWorkspace(monaco, workspaceRoot, activeFile, monacoWorkspaceDocumentsQuery.data, isDirty);
    });

    return () => {
      cancelled = true;
    };
  }, [activeFile, hasWorkspace, isDirty, monacoWorkspaceDocumentsQuery.data, workspaceRoot]);


  const handleToggleDirectory = (directoryId: string) => {
    setExpandedDirectoryIds((current) => {
      const next = new Set(current);
      if (next.has(directoryId)) {
        next.delete(directoryId);
      } else {
        next.add(directoryId);
      }
      return next;
    });
  };

  const handleWorkspacePick = async (rootDir: string) => {
    if (!rootDir) return;
    navigate({ to: '/', search: { workspace: rootDir } });
    await queryClient.invalidateQueries({ queryKey: ['workspace', 'active'] });
    await queryClient.invalidateQueries({ queryKey: ['workspace-file'] });
  };

  const handleSaveProvider = async (provider: LocalProviderSettings) => {
    setSettingsNotice(null);
    try {
      await updateLocalProviderMutation.mutateAsync({ providerId: provider.providerId, provider });
      setSettingsNotice(`Saved ${providerTitle(provider.providerId)}.`);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'provider-status'] });
    } catch (err) {
      setSettingsNotice(err instanceof Error ? err.message : 'Provider settings save failed.');
    }
  };

  const handleTestProvider = async (providerId: ProviderId) => {
    setSettingsNotice(null);
    setTestingProviderId(providerId);
    try {
      const result = await testProviderConnection(providerId);
      setSettingsNotice(`${providerTitle(providerId)} is ${result.ok ? 'ready' : 'not ready'}.`);
      await queryClient.invalidateQueries({ queryKey: ['settings', 'provider-status'] });
    } catch (err) {
      setSettingsNotice(err instanceof Error ? err.message : 'Provider test failed.');
    } finally {
      setTestingProviderId(null);
    }
  };

  const handleSaveFile = async () => {
    if (!activeFile || !isDirty) return;
    const filePath = activeFile;
    const draftToSave = editorDraft;
    const expectedContent = savedContent;
    setEditorNotice(null);
    try {
      const saved = await saveFileMutation.mutateAsync({ filePath, content: draftToSave, expectedContent });
      setEditorState((current) => current.filePath === filePath ? { ...current, saved: draftToSave } : current);
      setEditorNotice(`Saved ${saved.filePath} (${saved.bytes} bytes).`);
      await queryClient.invalidateQueries({ queryKey: ['workspace-file', filePath] });
      await queryClient.invalidateQueries({ queryKey: ['workspace', 'active'] });
      await queryClient.invalidateQueries({ queryKey: ['workspace', 'monaco-documents'] });
    } catch (err) {
      setEditorNotice(err instanceof Error ? err.message : 'Save failed.');
    }
  };

  const handleReloadFile = async () => {
    if (!activeFile) return;
    setEditorNotice(null);
    const result = await workspaceFileQuery.refetch();
    if (result.data) {
      setEditorState({ filePath: activeFile, draft: result.data.content, saved: result.data.content });
      setEditorNotice(`Reloaded ${activeFile}.`);
      await queryClient.invalidateQueries({ queryKey: ['workspace', 'monaco-documents'] });
    } else if (result.error) {
      setEditorNotice(result.error instanceof Error ? result.error.message : 'Reload failed.');
    }
  };

  const buildCollaborationContext = (sessionId: string, workflow: string) => ({
    workspaceId: 'workspace-local',
    sessionId,
    activeFilePath,
    selectedText,
    openFiles: workspaceQuery.data?.files.slice(0, 40),
    gitDiff,
    diagnostics,
    terminalOutput,
    repoSummary: workspaceQuery.data?.summary,
    metadata: activeProvider && activeModel ? {
      preferredProviderId: activeProvider.providerId,
      preferredModelId: activeModel.modelId,
      allowedProviderIds: [activeProvider.providerId],
      requestedWorkflow: workflow,
      routing: 'gateway-orchestrated',
      autoMultiAgent: true,
    } : {
      requestedWorkflow: workflow,
      routing: 'gateway-orchestrated',
      autoMultiAgent: true,
    },
  });

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt) return;
    const nextUserMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt };
    setMessages((current) => [...current, nextUserMessage]);
    setInput('');
    setIsStreaming(true);

    const streamId = crypto.randomUUID();
    setMessages((current) => [...current, {
      id: streamId,
      role: 'assistant',
      content: 'Starting gateway-orchestrated auto team run...',
      warnings: [],
      toolCalls: ['gateway auto team selection', 'multi-agent orchestration'],
    }]);

    try {
      const result = await collaborationMutation.mutateAsync({
        goal: prompt,
        team: 'auto',
        workflowId: selectedWorkflowId || undefined,
        maxTokensPerRole: selectedWorkflowForRun?.maxTokensPerRole ?? 1800,
        temperature: selectedWorkflowForRun?.temperature ?? 0.2,
        context: buildCollaborationContext(`multi-agent-${Date.now()}`, 'auto-agent-command'),
      });

      setLastCollaboration(result);
      const teamId = typeof result.metadata?.teamId === 'string' ? result.metadata.teamId : 'auto';
      const teamReason = typeof result.metadata?.teamReason === 'string' ? result.metadata.teamReason : 'Gateway selected the multi-agent team.';
      const roleSummary = result.outputs
        .map((output) => `${output.specialistAgentName ?? output.role}: ${output.summary}`)
        .join('\n');
      setMessages((current) => current.map((message) => message.id === streamId ? {
        ...message,
        content: [
          `Multi-agent gateway run complete with ${teamId} (${result.outputs.filter((output) => output.status === 'completed').length}/${result.outputs.length} roles).`,
          teamReason,
          '',
          result.finalOutput.content || result.finalOutput.summary,
          '',
          'Role outputs:',
          roleSummary,
        ].join('\n'),
        warnings: result.warnings,
        toolCalls: [
          `team: ${teamId}`,
          ...((result.metadata?.executionWaves as string[][] | undefined)?.map((wave, index) => `wave ${index + 1}: ${wave.join(' + ')}`) ?? []),
        ],
      } : message));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((current) => current.map((chatMessage) => chatMessage.id === streamId ? {
        ...chatMessage,
        content: `Multi-agent gateway request failed: ${message}`,
        warnings: [...(chatMessage.warnings ?? []), 'The gateway collaboration endpoint did not complete this run.'],
      } : chatMessage));
    } finally {
      setIsStreaming(false);
      await queryClient.invalidateQueries({ queryKey: ['workspace', 'active'] });
      await queryClient.invalidateQueries({ queryKey: ['patches'] });
      await queryClient.invalidateQueries({ queryKey: ['trace', 'sessions'] });
    }
  };

  const handleRunCollaboration = async () => {
    const goal = collaborationGoal.trim();
    if (!goal) return;

    setCollaborationError(null);
    try {
      const result = await collaborationMutation.mutateAsync({
        goal,
        team: 'auto',
        workflowId: selectedWorkflowId || undefined,
        maxTokensPerRole: selectedWorkflowForRun?.maxTokensPerRole ?? 1800,
        temperature: selectedWorkflowForRun?.temperature ?? 0.2,
        context: buildCollaborationContext(`multi-agent-${Date.now()}`, 'ai-coding-team'),
      });
      setLastCollaboration(result);
      const teamId = typeof result.metadata?.teamId === 'string' ? result.metadata.teamId : 'auto';
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Multi-agent run complete with ${teamId} (${result.outputs.filter((output) => output.status === 'completed').length}/${result.outputs.length} roles): ${result.finalOutput.summary}`,
        warnings: result.warnings,
      }]);
      await queryClient.invalidateQueries({ queryKey: ['trace', 'sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['patches'] });
    } catch (err) {
      setCollaborationError(err instanceof Error ? err.message : 'Multi-agent collaboration failed.');
    }
  };

  const handlePatchAction = async (patchId: string, action: 'review' | 'approve' | 'reject' | 'apply') => {
    setPatchActionPendingId(patchId);
    try {
      await patchActionMutation.mutateAsync({ patchId, action });
      await queryClient.invalidateQueries({ queryKey: ['patches'] });
      await queryClient.invalidateQueries({ queryKey: ['trace', 'sessions'] });
    } finally {
      setPatchActionPendingId(null);
    }
  };

  const handleSearchObsidian = async () => {
    const query = obsidianSearchQuery.trim();
    if (!query) return;
    const notes = await obsidianSearchMutation.mutateAsync(query);
    setObsidianSearchResults(notes);
  };

  const handleSaveAgent = async () => {
    setAgentSaveError(null);
    try {
      const result = await saveAgentMutation.mutateAsync(agentDraft);
      setAvailableAgents(result.agents.filter((agent) => agent.selectable));
      setAgentDraft({
        name: '',
        description: '',
        mode: 'plan',
        prompt: '',
        temperature: 0.2,
        selectable: true,
      });
    } catch (err) {
      setAgentSaveError(err instanceof Error ? err.message : 'Agent save failed.');
    }
  };

  const handleSelectWorkflow = (workflowId: string) => {
    setSelectedWorkflowId(workflowId);
    const workflow = workflows.find((candidate) => candidate.id === workflowId);
    if (workflow) {
      setWorkflowDraft({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        roles: workflow.roles,
        graph: workflow.graph ?? buildWorkflowGraph(workflow.roles),
        team: workflow.team ?? 'auto',
        maxTokensPerRole: workflow.maxTokensPerRole ?? 1800,
        temperature: workflow.temperature ?? 0.2,
      });
    }
  };

  const handleSaveWorkflow = async () => {
    setWorkflowSaveError(null);
    try {
      const result = await saveWorkflowMutation.mutateAsync(workflowDraft);
      const saved = result.workflows.find((workflow) => workflow.name === workflowDraft.name.trim()) ?? result.workflows[0];
      if (saved) {
        setSelectedWorkflowId(saved.id);
        setWorkflowDraft({
          id: saved.id,
          name: saved.name,
          description: saved.description,
          roles: saved.roles,
          graph: saved.graph ?? buildWorkflowGraph(saved.roles),
          team: saved.team ?? 'auto',
          maxTokensPerRole: saved.maxTokensPerRole ?? 1800,
          temperature: saved.temperature ?? 0.2,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
    } catch (err) {
      setWorkflowSaveError(err instanceof Error ? err.message : 'Workflow save failed.');
    }
  };

  return (
    <div className="app-shell app-shell--opencode">
      <header className="app-shell__windowbar">
        <div className="app-shell__window-left">
          <div className="app-shell__window-controls" aria-hidden="true">
            <span className="app-shell__window-dot app-shell__window-dot--close" />
            <span className="app-shell__window-dot app-shell__window-dot--minimize" />
            <span className="app-shell__window-dot app-shell__window-dot--maximize" />
          </div>
        </div>
        <div className="app-shell__window-title">
          <strong>{visibleWorkspaceName} — {currentTabName}</strong>
        </div>
        <div className="app-shell__window-actions">
          <button type="button" className="app-shell__window-link app-shell__window-link--button" onClick={() => setIsAgentManagerOpen(true)}>
            Open Agent Manager
          </button>
          <span className={`app-shell__window-state ${workspacePresence === 'error' ? 'app-shell__window-state--error' : workspacePresence === 'ready' ? 'app-shell__window-state--healthy' : ''}`}>
            <span className="app-shell__status-dot" />
            {healthyProviders} ready
          </span>
          <button type="button" className="app-shell__icon-button" aria-label="Layout">
            <span className="app-shell__icon app-shell__icon--layout" aria-hidden="true" />
          </button>
          <button type="button" className="app-shell__icon-button" aria-label="Search">
            <span className="app-shell__icon app-shell__icon--search" aria-hidden="true" />
          </button>
          <button type="button" className="app-shell__icon-button" aria-label="Preferences">
            <span className="app-shell__icon app-shell__icon--gear" aria-hidden="true" />
          </button>
          <button type="button" className="app-shell__icon-button app-shell__icon-button--avatar" aria-label="Account">
            <span className="app-shell__avatar-dot" aria-hidden="true" />
          </button>
        </div>
      </header>

      {shouldShowWelcome ? (
        <WorkspaceSelector
          onWorkspaceSelected={(rootDir) => void handleWorkspacePick(rootDir)}
        />
      ) : (
        <>
          <main className="app-shell__workspace-frame">
            <nav className="app-shell__activity-rail" aria-label="Workbench">
              <div className="app-shell__activity-logo">
                <span className="app-shell__activity-mark" />
              </div>
              <button
                type="button"
                className="app-shell__activity-item app-shell__activity-item--active"
                title="Explorer"
                aria-label="Explorer"
              >
                <span className="app-shell__activity-glyph app-shell__activity-glyph--files" aria-hidden="true" />
              </button>
              <button type="button" className="app-shell__activity-item" title="Search" aria-label="Search">
                <span className="app-shell__activity-glyph app-shell__activity-glyph--search" aria-hidden="true" />
              </button>
              <button type="button" className="app-shell__activity-item" title="Agent" aria-label="Agent" onClick={() => setIsAgentManagerOpen(true)}>
                <span className="app-shell__activity-glyph app-shell__activity-glyph--branch" aria-hidden="true" />
              </button>
              <div className="app-shell__activity-spacer" />
              <button
                type="button"
                className={isSettingsOpen ? 'app-shell__activity-item app-shell__activity-item--active' : 'app-shell__activity-item'}
                title="Settings"
                aria-label="Settings"
                onClick={() => setIsSettingsOpen(true)}
              >
                <span className="app-shell__activity-glyph app-shell__activity-glyph--settings" aria-hidden="true" />
              </button>
              <div className="app-shell__activity-meta" title="Profile" aria-label="Profile">
                <span className="app-shell__activity-glyph app-shell__activity-glyph--account" aria-hidden="true" />
              </div>
            </nav>

            <aside className="app-shell__explorer-panel">
              <div className="app-shell__pane-header app-shell__pane-header--explorer">
                <h2>Explorer</h2>
                <div className="app-shell__pane-tools" aria-hidden="true">
                  <span className="app-shell__pane-tool" />
                  <span className="app-shell__pane-tool app-shell__pane-tool--dots" />
                </div>
              </div>
              <section className="app-shell__sidebar-section app-shell__sidebar-section--grow">
                <div className="app-shell__sidebar-section-title">Folders</div>
                <div className="app-shell__sidebar-section-meta" title={workspaceRoot || visibleWorkspaceName}>
                  {workspaceRoot || visibleWorkspaceName}
                </div>
                <div className="app-shell__explorer-tree">
                  {workspaceQuery.isLoading && <div className="app-shell__empty-list">Loading workspace files...</div>}
                  {workspaceQuery.isError && <div className="app-shell__empty-list">Model gateway workspace API is unavailable.</div>}
                  {!workspaceQuery.isLoading && !workspaceQuery.isError && workspaceFiles.length === 0 && <div className="app-shell__empty-list">No files indexed. Start or re-index the gateway workspace.</div>}
                  {!workspaceQuery.isLoading && !workspaceQuery.isError && workspaceFiles.length > 0 && (
                    <ExplorerTree
                      nodes={explorerNodes}
                      activeFile={activeFile}
                      workspaceRoot={workspaceRoot}
                      expandedDirectoryIds={expandedDirectoryIds}
                      onToggleDirectory={handleToggleDirectory}
                      onOpenFile={openTabForFile}
                    />
                  )}
                </div>
              </section>
              <div className="app-shell__explorer-footer" aria-hidden="true">
                <span>Outline</span>
                <span>Timeline</span>
              </div>
            </aside>

            <section className="app-shell__editor-column">
              <div className="app-shell__editor-chrome">
                <div className="app-shell__editor-tabs" aria-label="Open tabs">
                  {openTabs.map((tab) => (
                    <div key={tab.id} className={tab.filePath === activeFile ? 'app-shell__editor-tab app-shell__editor-tab--active' : 'app-shell__editor-tab'}>
                      <button
                        type="button"
                        className="app-shell__editor-tab-link"
                        onClick={() => {
                          navigate({ to: '/', search: { file: tab.filePath, workspace: workspaceRoot || undefined } });
                        }}
                      >
                        <MaterialItemIcon descriptor={getFileIconDescriptor(tab.filePath)} className="app-shell__material-icon--tab" />
                        <span className="app-shell__editor-tab-label">{getBasename(tab.filePath)}</span>
                      </button>
                      <button
                        type="button"
                        className="app-shell__editor-tab-close"
                        aria-label={`Close ${getBasename(tab.filePath)}`}
                        onClick={() => closeTab(tab.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {!openTabs.length && <span className="app-shell__editor-tab app-shell__editor-tab--placeholder">No file</span>}
                </div>
                <div className="app-shell__editor-actions">
                  <span className={isDirty ? 'app-shell__file-status app-shell__file-status--dirty' : 'app-shell__file-status app-shell__file-status--saved'}>{fileStatus}</span>
                  <button type="button" className="app-shell__ghost-button app-shell__ghost-button--quiet" onClick={() => void handleReloadFile()} disabled={!activeFile || workspaceFileQuery.isFetching}>Reload</button>
                  <button type="button" className="app-shell__ghost-button app-shell__ghost-button--quiet" onClick={() => void handleSaveFile()} disabled={!activeFile || !isDirty || saveFileMutation.isPending}>{saveFileMutation.isPending ? 'Saving...' : 'Save'}</button>
                  {workspaceFiles.includes('apps/web/src/app.tsx') && <button type="button" className="app-shell__ghost-button app-shell__ghost-button--quiet" onClick={() => openTabForFile('apps/web/src/app.tsx')}>Open app.tsx</button>}
                </div>
              </div>

              <section className="app-shell__editor">
                <div className="app-shell__breadcrumbs">
                  <div className="app-shell__breadcrumbs-path">
                    {breadcrumbSegments.length === 0 && <span>No file selected</span>}
                    {breadcrumbSegments.map((segment, index) => (
                      <span key={`${segment}:${index}`}>{segment}</span>
                    ))}
                  </div>
                  <div className="app-shell__breadcrumbs-meta">
                    <span>{getEditorLanguage(activeFile)}</span>
                    <span>{primaryProvider}</span>
                  </div>
                </div>
                {(editorNotice || workspaceFileQuery.isError) && <div className="app-shell__editor-notice">{editorNotice ?? (workspaceFileQuery.error instanceof Error ? workspaceFileQuery.error.message : 'File load failed.')}</div>}
                <div className="app-shell__editor-mount">
                  <Editor
                    key={activeFile || 'empty-editor'}
                    height="100%"
                    language={getMonacoLanguage(activeFile)}
                    path={monacoEditorPath}
                    theme="vs-dark"
                    value={editorDraft}
                    beforeMount={(monaco) => {
                      const compilerOptions = getMonacoCompilerOptions(monaco, workspaceRoot, activeFile, monacoWorkspaceDocumentsQuery.data ?? {});
                      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
                      monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
                      monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
                      monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
                    }}
                    onChange={(value) => {
                      setEditorNotice(null);
                      setEditorState((current) => current.filePath === activeFile ? { ...current, draft: value ?? '' } : { filePath: activeFile, draft: value ?? '', saved: workspaceFileQuery.data?.content ?? '' });
                    }}
                    onMount={(editor) => {
                      editor.onDidChangeCursorSelection(() => {
                        const selection = editor.getSelection();
                        const model = editor.getModel();
                        if (!selection || !model || selection.isEmpty()) {
                          setEditorSelection(null);
                          return;
                        }
                        const text = model.getValueInRange(selection);
                        setEditorSelection({ text, filePath: activeFileRef.current });
                      });
                    }}
                    options={{
                      minimap: { enabled: true, renderCharacters: false, scale: 1 },
                      fontSize: 14,
                      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      smoothScrolling: true,
                      padding: { top: 18, bottom: 18 },
                    }}
                  />
                </div>
              </section>

              <section className="app-shell__dock" aria-label="Workspace dock">
                <section className="app-shell__bottom-panel" aria-label="Workbench panel">
                  <div className="app-shell__panel-tabbar">
                    <span className="app-shell__panel-tab">Problems {diagnostics.length}</span>
                    <span className="app-shell__panel-tab">Output</span>
                    <span className="app-shell__panel-tab app-shell__panel-tab--active">Terminal</span>
                    <span className="app-shell__panel-tab">Debug Console</span>
                  </div>
                  <Terminal />
                </section>
              </section>
            </section>

            <aside className="app-shell__agent-panel">
              <div className="app-shell__agent-toolbar">
                <div className="app-shell__agent-toolbar-group">
                  <button type="button" className="app-shell__icon-button app-shell__icon-button--small" aria-label="Home">
                    <span className="app-shell__icon app-shell__icon--home" aria-hidden="true" />
                  </button>
                  <button type="button" className="app-shell__icon-button app-shell__icon-button--small" aria-label="History">
                    <span className="app-shell__icon app-shell__icon--history" aria-hidden="true" />
                  </button>
                </div>
                <div className="app-shell__agent-toolbar-group">
                  <span className="app-shell__agent-toolbar-label">{primaryProvider}</span>
                  <span className="app-shell__agent-toolbar-label">{patchCards.length} patches</span>
                </div>
              </div>
              <div className="app-shell__agent-thread-header">
                <div>
                  <span className="app-shell__agent-thread-kicker">{selectedMode}</span>
                  <strong>{currentTabName}</strong>
                </div>
                <span className={isStreaming ? 'app-shell__agent-live app-shell__agent-live--busy' : 'app-shell__agent-live'} aria-label={isStreaming ? 'Agent is thinking' : 'Agent ready'} />
              </div>
              <div className="app-shell__chat-thread">
                {messages.map((message) => (
                  <article key={message.id} className={message.role === 'user' ? 'app-shell__chat-bubble app-shell__chat-bubble--user' : 'app-shell__chat-bubble'}>
                    <div className="app-shell__chat-bubble-header">
                      <strong>{message.role === 'user' ? 'You' : 'Agent'}</strong>
                      {message.role === 'assistant' && message.id !== 'seed-assistant' && <span>{isStreaming && message.content.length === 0 ? 'thinking' : 'done'}</span>}
                    </div>
                    <p>{message.content || 'Streaming response...'}</p>
                    {!!message.warnings?.length && (<ul className="app-shell__warning-list">{message.warnings.map((warning) => (<li key={warning}>{warning}</li>))}</ul>)}
                    {!!message.toolCalls?.length && (<div className="app-shell__tool-list">{message.toolCalls.map((toolCall) => (<span key={toolCall} className="app-shell__tool-pill">{toolCall}</span>))}</div>)}
                  </article>
                ))}
              </div>
              <form className="app-shell__agent-composer-card" onSubmit={(event) => { event.preventDefault(); void handleSend(); }}>
                <div className="app-shell__composer-body">
                  <label className="app-shell__sr-only" htmlFor="agent-message-input">Agent message</label>
                  <textarea id="agent-message-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask anything..." rows={3} />
                  <button type="submit" className="app-shell__ghost-button app-shell__agent-send-button" disabled={isStreaming} aria-label="Send to agent">
                    <span className="app-shell__agent-send-arrow" aria-hidden="true" />
                  </button>
                </div>
                <div className="app-shell__agent-control-strip-row">
                  <button type="button" className="app-shell__agent-plus-button" aria-label="Add context">+</button>
                  <div className="app-shell__agent-control-field">
                    <span className="app-shell__agent-auto-team-pill" title="Gateway automatically chooses the multi-agent team for each request">
                      Auto Team
                    </span>
                  </div>
                  <div className="app-shell__agent-control-field app-shell__agent-control-field--wide">
                    <label className="app-shell__sr-only" htmlFor="model-select">Select model</label>
                    <select
                      id="model-select"
                      className="app-shell__agent-omnibar-select"
                      value={activeProvider && activeModel ? `${activeProvider.providerId}/${activeModel.modelId}` : ''}
                      onChange={(event) => {
                        const [providerId, ...modelSegments] = event.target.value.split('/');
                        setSelectedProviderId(providerId as ProviderId);
                        setSelectedModelId(modelSegments.join('/'));
                      }}
                      disabled={readyProviders.length === 0}
                    >
                      {readyProviders.length === 0 ? (
                        <option value="">No model</option>
                      ) : (
                        readyProviders.flatMap((provider) => provider.models.map((model) => (
                          <option key={`${provider.providerId}/${model.modelId}`} value={`${provider.providerId}/${model.modelId}`}>
                            {providerTitle(provider.providerId)} · {model.modelId}
                          </option>
                        )))
                      )}
                    </select>
                  </div>
                  <div className="app-shell__agent-control-field">
                    <label className="app-shell__sr-only" htmlFor="reasoning-select">Select reasoning level</label>
                    <select
                      id="reasoning-select"
                      className="app-shell__agent-omnibar-select"
                      value={selectedReasoningLevel}
                      onChange={(event) => setSelectedReasoningLevel(event.target.value as 'Default' | 'Low' | 'Medium' | 'High' | 'Max')}
                    >
                      {(['Default', 'Low', 'Medium', 'High', 'Max'] as const).map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </form>
            </aside>
          </main>

          {isAgentManagerOpen && (
            <AgentManagerModal
              agents={availableAgents}
              activeAgentId={selectedAgentId}
              providerStatuses={providerStatuses}
              traces={traces}
              patches={patchCards}
              workspaceFiles={workspaceFiles}
              workspaceRoot={workspaceRoot}
              workspaceSummary={workspaceQuery.data?.summary}
              obsidianMemoryStats={obsidianMemoryStats}
              obsidianSearchQuery={obsidianSearchQuery}
              obsidianSearchResults={obsidianSearchResults}
              isSearchingObsidian={obsidianSearchMutation.isPending}
              agentDraft={agentDraft}
              isSavingAgent={saveAgentMutation.isPending}
              agentSaveError={agentSaveError}
              workflows={workflows}
              selectedWorkflowId={selectedWorkflowId}
              workflowDraft={workflowDraft}
              isSavingWorkflow={saveWorkflowMutation.isPending}
              workflowSaveError={workflowSaveError}
              collaborationGoal={collaborationGoal}
              isRunningCollaboration={collaborationMutation.isPending}
              lastCollaboration={lastCollaboration}
              collaborationError={collaborationError}
              patchActionPendingId={patchActionPendingId}
              onCollaborationGoalChange={setCollaborationGoal}
              onObsidianSearchQueryChange={setObsidianSearchQuery}
              onSearchObsidian={() => void handleSearchObsidian()}
              onAgentDraftChange={setAgentDraft}
              onSaveAgent={() => void handleSaveAgent()}
              onSelectedWorkflowChange={handleSelectWorkflow}
              onWorkflowDraftChange={setWorkflowDraft}
              onSaveWorkflow={() => void handleSaveWorkflow()}
              onRunCollaboration={() => void handleRunCollaboration()}
              onReviewPatch={(patchId) => void handlePatchAction(patchId, 'review')}
              onApprovePatch={(patchId) => void handlePatchAction(patchId, 'approve')}
              onRejectPatch={(patchId) => void handlePatchAction(patchId, 'reject')}
              onApplyPatch={(patchId) => void handlePatchAction(patchId, 'apply')}
              onClose={() => setIsAgentManagerOpen(false)}
            />
          )}

          {isSettingsOpen && (
            <div className="app-shell__modal-backdrop" role="presentation" onMouseDown={() => setIsSettingsOpen(false)}>
              <section
                className="app-shell__settings-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-modal-title"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <header className="app-shell__settings-modal-header">
                  <div>
                    <h2 id="settings-modal-title">Settings</h2>
                    <span>Providers</span>
                  </div>
                  <button type="button" className="app-shell__icon-button" aria-label="Close settings" onClick={() => setIsSettingsOpen(false)}>
                    ×
                  </button>
                </header>
                {settingsNotice && <div className="app-shell__settings-notice">{settingsNotice}</div>}
                <ProviderSettingsPanel
                  settings={settingsQuery.data}
                  providerStatuses={providerStatuses}
                  isLoading={settingsQuery.isLoading}
                    error={settingsQuery.error}
                    isSaving={updateSettingsMutation.isPending || updateLocalProviderMutation.isPending}
                  testingProviderId={testingProviderId}
                  onSaveProvider={handleSaveProvider}
                  onTestProvider={handleTestProvider}
                />
              </section>
            </div>
          )}

          <footer className="app-shell__statusbar">
            <div className="app-shell__statusbar-group">
              <span>{workspaceName}</span>
              <span>{getEditorLanguage(activeFile)}</span>
              <span>{diagnostics.length} diagnostics</span>
            </div>
            <div className="app-shell__statusbar-group">
              <span>{activeProvider?.providerId ?? 'offline'}</span>
              <span>{activeModelId}</span>
              <span>{selectedMode}</span>
              <span>{selectedReasoningLevel}</span>
              <span>{patchCards.length} patches</span>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
