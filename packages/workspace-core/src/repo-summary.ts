import type { FileEntry, FileKind } from './workspace-index';
import type { WorkspaceSearch } from './workspace-search';

export interface RepoContext {
  files: FileEntry[];
  fileCount: number;
  byKind: Record<string, number>;
  byExtension: Record<string, number>;
}

export interface WorkspaceContextProvider {
  getContext(): Promise<RepoContext>;
  getFilePaths(filter?: FileKind): Promise<string[]>;
  readFileContent(path: string): Promise<string>;
  getRepoSummary(): Promise<string>;
}
