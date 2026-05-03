export {
  InMemoryWorkspaceIndex,
  type WorkspaceIndex,
  type FileEntry,
  type FileKind,
  type SymbolEntry,
} from './workspace-index';

export {
  type WorkspaceSearch,
  type SearchResult,
} from './workspace-search';

export {
  type RepoContext,
  type WorkspaceContextProvider,
} from './repo-summary';

export {
  ProjectDetector,
  type ProjectInfo,
  type ProjectDetectorOptions,
} from './project-detector';

export {
  ObsidianKnowledgeBase,
  type ObsidianNote,
  type ObsidianChunk,
  type ObsidianKBQuery,
  type ObsidianRAGQuery,
  type ObsidianRAGResult,
  type ObsidianKBOptions,
} from './obsidian-kb';
