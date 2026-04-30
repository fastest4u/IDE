import type { FileEntry } from './workspace-index';

export interface SearchResult {
  filePath: string;
  line: number;
  content: string;
  snippet: string;
}

export interface WorkspaceSearch {
  searchByContent(query: string, rootDir: string): Promise<SearchResult[]>;
  searchByFileName(pattern: string, rootDir: string): Promise<FileEntry[]>;
  getRelevantFiles(
    query: string,
    files: FileEntry[],
    readFile: (path: string) => Promise<string>,
  ): Promise<Array<{ path: string; content: string }>>;
}
