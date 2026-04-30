import React, { useState, useCallback, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { indexWorkspace, getWorkspaceSummary, listWorkspaceFiles, pickWorkspaceDirectory } from '../services/model-gateway';
import type { ModelGatewayError } from '../services/model-gateway';

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  summary: string;
  fileCount: number;
  lastOpened: string;
  isIndexed: boolean;
}

interface WorkspaceSelectorProps {
  onWorkspaceSelected: (path: string) => void;
  onSkip?: () => void;
}

const RECENT_WORKSPACES_KEY = 'ide-recent-workspaces';

function isLikelyWorkspaceRootPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === '~' || trimmed === '.') return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return true;
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('.\\') || trimmed.startsWith('..\\')) return true;
  return /^[a-zA-Z]:[\\/]/.test(trimmed);
}

function sanitizeRecentWorkspaces(input: unknown): WorkspaceInfo[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const sanitized: WorkspaceInfo[] = [];

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const candidate = entry as Partial<WorkspaceInfo>;
    if (typeof candidate.path !== 'string' || !isLikelyWorkspaceRootPath(candidate.path)) {
      continue;
    }

    sanitized.push({
      id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : crypto.randomUUID(),
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : candidate.path.split(/[\\/]/).filter(Boolean).pop() ?? 'Workspace',
      path: candidate.path.trim(),
      summary: typeof candidate.summary === 'string' ? candidate.summary : '',
      fileCount: typeof candidate.fileCount === 'number' && Number.isFinite(candidate.fileCount) ? candidate.fileCount : 0,
      lastOpened: typeof candidate.lastOpened === 'string' && candidate.lastOpened.trim() ? candidate.lastOpened : new Date(0).toISOString(),
      isIndexed: candidate.isIndexed !== false,
    });
  }

  return sanitized.slice(0, 8);
}

function useRecentWorkspaces() {
  const [recent, setRecent] = useState<WorkspaceInfo[]>([]);
  
  useEffect(() => {
    const stored = localStorage.getItem(RECENT_WORKSPACES_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as unknown;
        const sanitized = sanitizeRecentWorkspaces(parsed);
        setRecent(sanitized);
        localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(sanitized));
      } catch {
        setRecent([]);
        localStorage.removeItem(RECENT_WORKSPACES_KEY);
      }
    }
  }, []);

  const addRecent = useCallback((workspace: WorkspaceInfo) => {
    setRecent(prev => {
      const filtered = prev.filter(w => w.path !== workspace.path);
      const updated = [workspace, ...filtered].slice(0, 8);
      localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const removeRecent = useCallback((path: string) => {
    setRecent(prev => {
      const updated = prev.filter(w => w.path !== path);
      localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearRecent = useCallback(() => {
    setRecent([]);
    localStorage.removeItem(RECENT_WORKSPACES_KEY);
  }, []);

  return { recent, addRecent, removeRecent, clearRecent };
}

export function WorkspaceSelector({ onWorkspaceSelected, onSkip }: WorkspaceSelectorProps) {
  const [pathInput, setPathInput] = useState('');
  const [isIndexing, setIsIndexing] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { recent, addRecent, removeRecent, clearRecent } = useRecentWorkspaces();
  const queryClient = useQueryClient();

  const indexMutation = useMutation({
    mutationFn: indexWorkspace,
    onSuccess: async (data) => {
      const summary = await getWorkspaceSummary();
      const files = await listWorkspaceFiles();
      
      const workspace: WorkspaceInfo = {
        id: crypto.randomUUID(),
        name: summary.name || data.rootDir.split('/').pop() || 'Workspace',
        path: data.rootDir,
        summary: summary.summary || data.summary,
        fileCount: files.count,
        lastOpened: new Date().toISOString(),
        isIndexed: true,
      };
      
      addRecent(workspace);
      setIsIndexing(false);
      queryClient.invalidateQueries({ queryKey: ['workspace'] });
      onWorkspaceSelected(data.rootDir);
    },
    onError: (err, rootDir) => {
      const message = err instanceof Error ? err.message : 'Failed to open workspace';
      if (typeof rootDir === 'string' && message.includes('Workspace root was not found')) {
        removeRecent(rootDir);
      }
      setError(message);
      setIsIndexing(false);
    },
  });

  const handleOpenFolder = useCallback(async () => {
    if (!pathInput.trim()) {
      setError('Please enter a workspace path');
      return;
    }
    setError(null);
    setIsIndexing(true);
    indexMutation.mutate(pathInput.trim());
  }, [pathInput, indexMutation]);

  const handleBrowseFolder = useCallback(async () => {
    setError(null);
    setIsBrowsing(true);

    try {
      const result = await pickWorkspaceDirectory(pathInput.trim() || undefined);
      setPathInput(result.rootDir);
      setIsIndexing(true);
      indexMutation.mutate(result.rootDir);
    } catch (err) {
      const pickerError = err as ModelGatewayError;
      if (pickerError.code !== 'WORKSPACE_PICKER_CANCELLED') {
        setError(pickerError.message || 'Failed to choose workspace');
      }
    } finally {
      setIsBrowsing(false);
    }
  }, [indexMutation, pathInput]);

  const handleRecentClick = useCallback((workspace: WorkspaceInfo) => {
    setError(null);
    setIsIndexing(true);
    indexMutation.mutate(workspace.path);
  }, [indexMutation]);

  const handleRemoveRecent = useCallback((path: string) => {
    removeRecent(path);
  }, [removeRecent]);

  const formatDate = (isoDate: string) => {
    const date = new Date(isoDate);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) {
      const hours = Math.floor(diff / (1000 * 60 * 60));
      if (hours === 0) return 'Just now';
      return `${hours}h ago`;
    }
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  };

  const formatFileCount = (count: number) => {
    if (count >= 1000) return `${(count / 1000).toFixed(1)}k files`;
    return `${count} files`;
  };

  return (
    <div className="workspace-selector">
      <div className="workspace-selector__bg" />
      <div className="workspace-selector__container">
        {/* Left Sidebar */}
        <aside className="workspace-selector__sidebar">
          <div className="workspace-selector__logo">
            <svg viewBox="0 0 48 48" fill="none" className="workspace-selector__logo-icon">
              <rect x="4" y="8" width="40" height="32" rx="6" fill="url(#logo-gradient)" />
              <rect x="8" y="12" width="32" height="24" rx="4" fill="rgba(255,255,255,0.1)" />
              <circle cx="16" cy="24" r="3" fill="rgba(255,255,255,0.9)" />
              <circle cx="24" cy="24" r="3" fill="rgba(255,255,255,0.9)" />
              <circle cx="32" cy="24" r="3" fill="rgba(255,255,255,0.9)" />
              <defs>
                <linearGradient id="logo-gradient" x1="0" y1="0" x2="48" y2="48">
                  <stop stopColor="#67e8f9" />
                  <stop offset="1" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
            </svg>
            <span className="workspace-selector__logo-text">My IDE</span>
          </div>
          <div className="workspace-selector__hero">
            <h1 className="workspace-selector__title">
              <span className="workspace-selector__title-accent">Welcome</span>
            </h1>
            <p className="workspace-selector__subtitle">
              Select a workspace to start coding with AI assistance
            </p>
          </div>
          {onSkip && (
            <button type="button" className="workspace-selector__skip" onClick={onSkip}>
              Skip for now
            </button>
          )}
        </aside>

        {/* Right Panel */}
        <main className="workspace-selector__main">
          {/* Open Folder */}
          <section className="workspace-selector__section">
            <h2 className="workspace-selector__section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="workspace-selector__section-icon" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              Open Folder
            </h2>
            <div className="workspace-selector__input-row">
              <div className="workspace-selector__input-wrapper">
                <svg className="workspace-selector__input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <label className="app-shell__sr-only" htmlFor="workspace-root-input">Workspace path</label>
                <input
                  id="workspace-root-input"
                  type="text"
                  className="workspace-selector__input"
                  placeholder="/Users/name/project or C:\\Users\\name\\project"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleOpenFolder()}
                  disabled={isIndexing || isBrowsing}
                />
              </div>
              <button
                type="button"
                className="workspace-selector__button workspace-selector__button--secondary"
                onClick={() => void handleBrowseFolder()}
                disabled={isIndexing || isBrowsing}
                title="Choose a workspace folder from this machine"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="workspace-selector__button-icon" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {isBrowsing ? 'Choosing...' : 'Browse'}
              </button>
              <button
                type="button"
                className="workspace-selector__button workspace-selector__button--primary"
                onClick={handleOpenFolder}
                disabled={isIndexing || isBrowsing || !pathInput.trim()}
              >
                {isIndexing ? (
                  <>
                    <span className="workspace-selector__spinner" aria-hidden="true" />
                    Indexing...
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="workspace-selector__button-icon" aria-hidden="true">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                    Open
                  </>
                )}
              </button>
            </div>
            <p className="workspace-selector__hint">
              Use `Browse` to open a native folder chooser on the machine running the gateway, or paste the workspace root path directly. `~` is supported for manual entry.
            </p>
            {error && (
              <div className="workspace-selector__error" role="alert" aria-live="polite">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="workspace-selector__error-icon" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
                {error}
              </div>
            )}
          </section>

          {/* Recent Workspaces */}
          {recent.length > 0 && (
            <section className="workspace-selector__section">
              <div className="workspace-selector__section-title-row">
                <h2 className="workspace-selector__section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="workspace-selector__section-icon" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Recent Workspaces
              </h2>
              <button type="button" className="workspace-selector__link-button" onClick={clearRecent}>Clear all</button>
              </div>
              <div className="workspace-selector__grid">
                {recent.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="workspace-selector__card"
                  >
                    <button
                      type="button"
                      className="workspace-selector__card-main"
                      onClick={() => handleRecentClick(workspace)}
                      disabled={isIndexing}
                      aria-label={`Open workspace ${workspace.name}`}
                    >
                    <span className="workspace-selector__card-icon">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </span>
                    <div className="workspace-selector__card-content">
                      <h3 className="workspace-selector__card-title">{workspace.name}</h3>
                      <p className="workspace-selector__card-path" title={workspace.path}>
                        {workspace.path}
                      </p>
                      <div className="workspace-selector__card-meta">
                        <span className="workspace-selector__card-files">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          {formatFileCount(workspace.fileCount)}
                        </span>
                        <span>{formatDate(workspace.lastOpened)}</span>
                      </div>
                    </div>
                    </button>
                    <button
                      type="button"
                      className="workspace-selector__card-remove"
                      onClick={() => handleRemoveRecent(workspace.path)}
                      aria-label={`Remove ${workspace.name} from recent workspaces`}
                      title="Remove from recent"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
