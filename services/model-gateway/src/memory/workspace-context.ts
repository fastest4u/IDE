import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  InMemoryWorkspaceIndex,
  ObsidianKnowledgeBase,
  type ObsidianNote,
  type FileKind,
} from '@ide/workspace-core';

import { WorkspacePathError, WorkspaceWriter, type GuardedWorkspacePath } from '../workspace-writer';

type WorkspaceFileErrorCode =
  | 'WORKSPACE_NOT_READY'
  | 'WORKSPACE_FILE_NOT_FOUND'
  | 'WORKSPACE_FILE_TOO_LARGE'
  | 'WORKSPACE_WRITE_CONFLICT'
  | 'WORKSPACE_INVALID_ROOT';

export class WorkspaceFileError extends Error {
  constructor(
    message: string,
    readonly code: WorkspaceFileErrorCode,
  ) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

export interface WorkspaceWriteResult {
  filePath: string;
  bytes: number;
  updatedAt: string;
}

export interface ObsidianMemoryStats {
  ready: boolean;
  total: number;
  byCategory: Record<string, number>;
  tags: string[];
}

export function resolveWorkspaceRootInput(rootDir: string): string {
  const trimmed = rootDir.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export class WorkspaceContextService {
  private index = new InMemoryWorkspaceIndex();
  private obsidianKb: ObsidianKnowledgeBase | null = null;
  private rootDir: string | null = null;
  private writer = new WorkspaceWriter();

  constructor(private readonly maxFileSize: number = 128 * 1024) {}

  async setWorkspaceRoot(rootDir: string): Promise<void> {
    const normalizedRootDir = resolveWorkspaceRootInput(rootDir);
    await this.assertWorkspaceRoot(normalizedRootDir);
    this.rootDir = normalizedRootDir;
    this.writer.setWorkspaceRoot(this.rootDir);
    this.obsidianKb = new ObsidianKnowledgeBase({ workspaceRoot: this.rootDir });
    await this.refreshIndex();
    await this.obsidianKb.buildIndex();
  }

  isReady(): boolean {
    return this.rootDir !== null && this.rootDir.length > 0;
  }

  getWorkspaceRoot(): string | null {
    return this.rootDir;
  }

  async refreshIndex(): Promise<void> {
    if (!this.rootDir) {
      throw new WorkspaceFileError('No workspace loaded', 'WORKSPACE_NOT_READY');
    }
    await this.index.indexDirectory(this.rootDir);
    if (this.obsidianKb) {
      await this.obsidianKb.buildIndex();
    }
  }

  async getRepoSummary(): Promise<string> {
    if (!this.rootDir) return 'No workspace loaded';
    return this.index.generateRepoSummary();
  }

  async getFilePaths(filter?: FileKind): Promise<string[]> {
    if (!this.rootDir) return [];
    const all = await this.index.listFiles();
    if (filter) {
      return all.filter((f) => f.kind === filter).map((f) => this.toWorkspaceRelativePath(f.path));
    }
    return all.map((f) => this.toWorkspaceRelativePath(f.path));
  }

  async readFileContent(filePath: string): Promise<string> {
    if (!this.rootDir) return `[No workspace loaded]`;
    try {
      return await this.readFileContentStrict(filePath);
    } catch (err) {
      if (err instanceof WorkspaceFileError) {
        if (err.code === 'WORKSPACE_FILE_TOO_LARGE') return `[${err.message}]`;
        if (err.code === 'WORKSPACE_FILE_NOT_FOUND') return `[Not found: ${filePath}]`;
        return `[${err.message}]`;
      }
      return `[Access denied: ${filePath}]`;
    }
  }

  async readFileContentStrict(filePath: string): Promise<string> {
    if (!this.rootDir) {
      throw new WorkspaceFileError('No workspace loaded', 'WORKSPACE_NOT_READY');
    }

    const guardedPath = this.writer.resolvePath(filePath);
    await this.assertReadableFile(guardedPath);

    const content = await this.writer.readFile(guardedPath.relativePath);
    if (content === null) {
      throw new WorkspaceFileError(`File not found: ${guardedPath.relativePath}`, 'WORKSPACE_FILE_NOT_FOUND');
    }
    return content;
  }

  async writeFileContent(input: {
    filePath: string;
    content: string;
    expectedContent?: string;
  }): Promise<WorkspaceWriteResult> {
    if (!this.rootDir) {
      throw new WorkspaceFileError('No workspace loaded', 'WORKSPACE_NOT_READY');
    }

    const byteLength = Buffer.byteLength(input.content, 'utf8');
    if (byteLength > this.maxFileSize) {
      throw new WorkspaceFileError(
        `File content exceeds limit: ${byteLength} bytes > ${this.maxFileSize} bytes`,
        'WORKSPACE_FILE_TOO_LARGE',
      );
    }

    const guardedPath = this.writer.resolvePath(input.filePath);
    const currentContent = input.expectedContent === undefined
      ? undefined
      : await this.writer.readFile(guardedPath.relativePath);

    if (input.expectedContent !== undefined && currentContent !== input.expectedContent) {
      throw new WorkspaceFileError(
        `Workspace file changed since it was loaded: ${guardedPath.relativePath}`,
        'WORKSPACE_WRITE_CONFLICT',
      );
    }

    try {
      await this.writer.writeFile(guardedPath.relativePath, input.content, input.expectedContent);
    } catch (err) {
      if (err instanceof WorkspacePathError && err.code === 'WORKSPACE_WRITE_CONFLICT') {
        throw new WorkspaceFileError(
          `Workspace file changed since it was loaded: ${guardedPath.relativePath}`,
          'WORKSPACE_WRITE_CONFLICT',
        );
      }
      throw err;
    }
    await this.refreshIndex();

    return {
      filePath: guardedPath.relativePath,
      bytes: byteLength,
      updatedAt: new Date().toISOString(),
    };
  }

  async searchFiles(query: string): Promise<Array<{ path: string; content: string }>> {
    if (!this.rootDir) return [];
    const files = await this.index.listFiles();
    const candidates = files.filter(
      (f) => f.kind === 'source' || f.kind === 'config' || f.kind === 'document',
    );
    const results: Array<{ path: string; content: string }> = [];
    const lowerQuery = query.toLowerCase();

    for (const file of candidates.slice(0, 200)) {
      try {
        const content = await this.index.readFile(file.path);
        if (content.length > this.maxFileSize) continue;
        if (content.toLowerCase().includes(lowerQuery)) {
          const relativePath = this.toWorkspaceRelativePath(file.path);
          results.push({ path: relativePath, content });
        }
      } catch {}
    }

    return results.slice(0, 20);
  }

  searchObsidianNotes(query: string, limit = 8): ObsidianNote[] {
    if (!this.obsidianKb) return [];
    return this.obsidianKb.search({ query, limit });
  }

  buildObsidianKnowledgeContext(query: string, maxNotes = 5): string {
    if (!this.obsidianKb) return '';
    return this.obsidianKb.buildKnowledgeContext(query, maxNotes);
  }

  getObsidianStats(): ObsidianMemoryStats {
    if (!this.obsidianKb) {
      return { ready: false, total: 0, byCategory: {}, tags: [] };
    }
    return { ready: true, ...this.obsidianKb.getStats() };
  }

  async writeObsidianMemoryNote(input: {
    title: string;
    sessionId: string;
    summary: string;
    content: string;
    tags?: string[];
  }): Promise<WorkspaceWriteResult> {
    if (!this.rootDir) {
      throw new WorkspaceFileError('No workspace loaded', 'WORKSPACE_NOT_READY');
    }

    const created = new Date().toISOString();
    const slug = slugify(`${created.slice(0, 10)}-${input.title}`);
    const filePath = `docs/memory/agent-sessions/${slug}.md`;
    const tags = ['project/my-ide', 'ai/memory', 'agent/session', ...(input.tags ?? [])];
    const note = [
      '---',
      `title: ${yamlString(input.title)}`,
      `created: ${created.slice(0, 10)}`,
      'status: active',
      'type: memory',
      'tags:',
      ...tags.map((tag) => `  - ${tag}`),
      `sessionId: ${yamlString(input.sessionId)}`,
      '---',
      '',
      `# ${input.title}`,
      '',
      '> [!note] Summary',
      `> ${input.summary.replace(/\n/g, '\n> ')}`,
      '',
      input.content,
      '',
      '## Related Notes',
      '',
      '- [[ai-first-ide]]',
      '- [[obsidian-vault-guide]]',
      '',
    ].join('\n');

    const saved = await this.writeFileContent({ filePath, content: note });
    if (this.obsidianKb) {
      await this.obsidianKb.buildIndex();
    }
    return saved;
  }

  async getActiveFileContext(
    activeFilePath?: string,
    openFiles?: string[],
  ): Promise<{
    activeFileContent?: string;
    openFileContents: Array<{ path: string; content: string }>;
  }> {
    const result: { activeFileContent?: string; openFileContents: Array<{ path: string; content: string }> } = {
      openFileContents: [],
    };

    if (activeFilePath) {
      result.activeFileContent = await this.readFileContent(activeFilePath);
    }

    if (openFiles?.length) {
      for (const file of openFiles.slice(0, 10)) {
        const content = await this.readFileContent(file);
        if (!content.startsWith('[')) {
          result.openFileContents.push({ path: file, content });
        }
      }
    }

    return result;
  }

  private async assertWorkspaceRoot(rootDir: string): Promise<void> {
    try {
      const stat = await fs.stat(rootDir);
      if (!stat.isDirectory()) {
        throw new WorkspaceFileError(`Workspace root is not a directory: ${rootDir}`, 'WORKSPACE_INVALID_ROOT');
      }
    } catch (err) {
      if (err instanceof WorkspaceFileError) {
        throw err;
      }
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new WorkspaceFileError(`Workspace root was not found: ${rootDir}`, 'WORKSPACE_INVALID_ROOT');
      }
      throw err;
    }
  }

  private async assertReadableFile(guardedPath: GuardedWorkspacePath): Promise<void> {
    try {
      const stat = await fs.stat(guardedPath.absolutePath);
      if (!stat.isFile()) {
        throw new WorkspaceFileError(`Not a file: ${guardedPath.relativePath}`, 'WORKSPACE_FILE_NOT_FOUND');
      }
      if (stat.size > this.maxFileSize) {
        throw new WorkspaceFileError(
          `File too large: ${guardedPath.relativePath} (${stat.size} bytes)`,
          'WORKSPACE_FILE_TOO_LARGE',
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceFileError) {
        throw err;
      }
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new WorkspaceFileError(`File not found: ${guardedPath.relativePath}`, 'WORKSPACE_FILE_NOT_FOUND');
      }
      throw err;
    }
  }

  private toWorkspaceRelativePath(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    if (!this.rootDir || !path.isAbsolute(filePath)) return normalized;
    return path.relative(this.rootDir, filePath).split(path.sep).join('/');
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || `memory-${Date.now()}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
