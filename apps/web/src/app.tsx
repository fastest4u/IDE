import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_PATCH_TOOL_SPEC } from '@ide/protocol';
import type { AIDiagnosticSummary } from '@ide/protocol';

import './styles.css';

import {
  indexWorkspace,
  listPatches,
  streamAIResponse,
  getWorkspaceFile,
  getWorkspaceSummary,
  listWorkspaceFiles,
  saveWorkspaceFile,
  getProviderRuntimeStatus,
} from './services/model-gateway';
import { Terminal, useTerminalOutput } from './components/terminal';
import { WorkspaceSelector } from './components/workspace-selector';
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

function useProviderRuntimeStatusQuery() {
  return useQuery({
    queryKey: ['settings', 'provider-status'],
    queryFn: getProviderRuntimeStatus,
    staleTime: 10_000,
    retry: false,
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

function getExplorerAncestorIds(filePath: string): string[] {
  const segments = filePath.split('/').filter(Boolean);
  const ancestors = [EXPLORER_ROOT_ID];
  let cursor = '';

  for (const segment of segments.slice(0, -1)) {
    cursor = cursor ? `${cursor}/${segment}` : segment;
    ancestors.push(cursor);
  }

  return ancestors;
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

export function AppShell() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { file?: string; workspace?: string };
  const requestedWorkspaceRoot = search.workspace ?? '';
  const hasExplicitWorkspaceSelection = requestedWorkspaceRoot.trim().length > 0;
  const workspaceQuery = useWorkspaceQuery(hasExplicitWorkspaceSelection);
  const patchesQuery = usePatchesQuery();
  const providerStatusQuery = useProviderRuntimeStatusQuery();
  const queryClient = useQueryClient();
  const saveFileMutation = useSaveWorkspaceFileMutation();
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: 'seed-assistant', role: 'assistant', content: 'Tell me what to inspect, refactor, or patch in this workspace.' }]);
  const [editorSelection, setEditorSelection] = useState<{ text: string; filePath: string } | null>(null);
  const [editorState, setEditorState] = useState<EditorState>({ filePath: '', draft: '', saved: '' });
  const [expandedDirectoryIds, setExpandedDirectoryIds] = useState<Set<string>>(() => new Set([EXPLORER_ROOT_ID]));
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedMode, setSelectedMode] = useState<'Build' | 'Inspect' | 'Patch'>('Inspect');
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<'Default' | 'Low' | 'Medium' | 'High' | 'Max'>('High');
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
  const providerStatuses = providerStatusQuery.data?.providers ?? [];
  const workspaceFiles = workspaceQuery.data?.files ?? [];

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
  const openTabForFile = (filePath: string) => {
    if (!filePath) return;
    const tabId = crypto.randomUUID();
    setOpenTabsState((current) => [...current, { id: tabId, filePath }]);
    navigate({ to: '/', search: { workspace: workspaceRoot || undefined, file: filePath } });
  };

  const closeTab = (tabId: string) => {
    const nextTabs = openTabsState.filter((tab) => tab.id !== tabId);
    const closedTab = openTabsState.find((tab) => tab.id === tabId);
    const nextActiveFile = closedTab && activeFile === closedTab.filePath ? nextTabs[nextTabs.length - 1]?.filePath ?? '' : activeFile;

    setOpenTabsState(nextTabs);
    const nextSearch = { workspace: workspaceRoot || undefined, ...(nextActiveFile ? { file: nextActiveFile } : {}) };
    navigate({ to: '/', search: nextSearch });
    void queryClient.invalidateQueries({ queryKey: ['workspace-file'] });
  };
  const activeProvider = providerStatuses.find((provider) => provider.enabled && provider.healthy) ?? providerStatuses.find((provider) => provider.enabled);
  const availableModels = activeProvider?.models ?? [];
  const activeModel = availableModels.find((model) => model.modelId === selectedModelId) ?? availableModels[0];
  const activeModelId = activeModel?.modelId ?? 'No model';
  const primaryProvider = activeProvider?.providerId ?? 'offline';
  const monacoEditorPath = hasWorkspace && activeFile ? getMonacoModelPath(workspaceRoot, activeFile) : 'file:///untitled';

  useEffect(() => {
    if (!selectedModelId && availableModels.length > 0) {
      setSelectedModelId(availableModels[0].modelId);
    }
  }, [availableModels, selectedModelId]);

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

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt) return;
    const nextUserMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: prompt };
    setMessages((current) => [...current, nextUserMessage]);
    setInput('');
    setIsStreaming(true);

    const streamId = crypto.randomUUID();
    setMessages((current) => [...current, { id: streamId, role: 'assistant', content: '', warnings: [], toolCalls: [] }]);

    try {
      const collectedText = await streamAIResponse(prompt, {
        kind: 'edit',
        preferredCapabilities: ['codeEditing', 'tools'],
        context: {
          workspaceId: 'workspace-local',
          sessionId: 'session-local',
          activeFilePath,
          selectedText,
          openFiles: workspaceQuery.data?.files.slice(0, 30),
          gitDiff,
          diagnostics,
          terminalOutput,
          repoSummary: workspaceQuery.data?.summary,
        },
        tools: [AI_PATCH_TOOL_SPEC],
      }, (event) => {
        if (event.type === 'delta') {
          setMessages((current) => current.map((message) => message.id === streamId ? { ...message, content: `${message.content}${event.text}` } : message));
        }
        if (event.type === 'warning') {
          setMessages((current) => current.map((message) => message.id === streamId ? { ...message, warnings: [...(message.warnings ?? []), event.message] } : message));
        }
        if (event.type === 'tool_call') {
          const patchId = typeof event.toolCall.arguments.patchId === 'string' ? event.toolCall.arguments.patchId : undefined;
          setMessages((current) => current.map((message) => message.id === streamId ? { ...message, toolCalls: [...(message.toolCalls ?? []), `${event.toolCall.name} -> ${patchId ?? event.toolCall.id}`] } : message));
          void queryClient.invalidateQueries({ queryKey: ['patches'] });
        }
      });

      setMessages((current) => current.map((message) => message.id === streamId ? { ...message, content: collectedText || message.content || 'Model gateway returned an empty response.' } : message));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((current) => current.map((chatMessage) => chatMessage.id === streamId ? {
        ...chatMessage,
        content: `Model gateway request failed: ${message}`,
        warnings: [...(chatMessage.warnings ?? []), 'The stream ended before a complete assistant response was received.'],
      } : chatMessage));
    } finally {
      setIsStreaming(false);
      await queryClient.invalidateQueries({ queryKey: ['workspace', 'active'] });
      await queryClient.invalidateQueries({ queryKey: ['patches'] });
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
          <span className="app-shell__window-link">Open Agent Manager</span>
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
              <button type="button" className="app-shell__activity-item app-shell__activity-item--active" title="Explorer" aria-label="Explorer">
                <span className="app-shell__activity-glyph app-shell__activity-glyph--files" aria-hidden="true" />
              </button>
              <button type="button" className="app-shell__activity-item" title="Search" aria-label="Search">
                <span className="app-shell__activity-glyph app-shell__activity-glyph--search" aria-hidden="true" />
              </button>
              <button type="button" className="app-shell__activity-item" title="Agent" aria-label="Agent">
                <span className="app-shell__activity-glyph app-shell__activity-glyph--branch" aria-hidden="true" />
              </button>
              <button type="button" className="app-shell__activity-item" title="Settings" aria-label="Settings">
                <span className="app-shell__activity-glyph app-shell__activity-glyph--run" aria-hidden="true" />
              </button>
              <div className="app-shell__activity-spacer" />
              <div className="app-shell__activity-meta">
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
                    <label className="app-shell__sr-only" htmlFor="mode-select">Select mode</label>
                    <select
                      id="mode-select"
                      className="app-shell__agent-omnibar-select"
                      value={selectedMode}
                      onChange={(event) => setSelectedMode(event.target.value as 'Build' | 'Inspect' | 'Patch')}
                    >
                      {(['Build', 'Inspect', 'Patch'] as const).map((mode) => (
                        <option key={mode} value={mode}>
                          {mode}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="app-shell__agent-control-field app-shell__agent-control-field--wide">
                    <label className="app-shell__sr-only" htmlFor="model-select">Select model</label>
                    <select
                      id="model-select"
                      className="app-shell__agent-omnibar-select"
                      value={activeModelId === 'No model' ? '' : activeModelId}
                      onChange={(event) => setSelectedModelId(event.target.value)}
                      disabled={availableModels.length === 0}
                    >
                      {availableModels.length === 0 ? (
                        <option value="">No model</option>
                      ) : (
                        availableModels.map((model) => (
                          <option key={model.modelId} value={model.modelId}>
                            {model.modelId}
                          </option>
                        ))
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
