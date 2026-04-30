import { promises as fs } from 'node:fs';
import path from 'node:path';

export type FileKind = 'source' | 'config' | 'document' | 'asset' | 'unknown';

export interface FileEntry {
  path: string;
  name: string;
  ext: string;
  size: number;
  kind: FileKind;
  isDirectory: boolean;
  children?: FileEntry[];
}

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'export' | 'unknown';
  filePath: string;
  line: number;
}

export interface WorkspaceIndex {
  indexDirectory(rootDir: string): Promise<FileEntry>;
  getFile(filePath: string): Promise<FileEntry | null>;
  readFile(filePath: string): Promise<string>;
  listFiles(pattern?: string): Promise<FileEntry[]>;
}

export interface WorkspaceIndexOptions {
  maxFiles?: number;
  maxDepth?: number;
  maxFileSize?: number;
}

const DEFAULT_INDEX_OPTIONS: Required<WorkspaceIndexOptions> = {
  maxFiles: 5000,
  maxDepth: 20,
  maxFileSize: 512 * 1024,
};

export class InMemoryWorkspaceIndex implements WorkspaceIndex {
  private fileTree: FileEntry | null = null;
  private rootDir: string | null = null;
  private rootRealPath: string | null = null;
  private indexedFiles = 0;
  private readonly options: Required<WorkspaceIndexOptions>;
  private readonly ignoredDirs = new Set([
    'node_modules', '.git', '.turbo', 'dist', 'build', '.next',
    '__pycache__', '.obsidian', '.DS_Store',
  ]);
  private readonly ignoredFiles = new Set([
    '.DS_Store', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json',
  ]);

  constructor(options: WorkspaceIndexOptions = {}) {
    this.options = { ...DEFAULT_INDEX_OPTIONS, ...options };
  }

  async indexDirectory(rootDir: string): Promise<FileEntry> {
    this.rootDir = path.resolve(rootDir);
    this.rootRealPath = await fs.realpath(this.rootDir).catch(() => this.rootDir);
    this.indexedFiles = 0;

    const rootName = path.basename(this.rootDir) || 'workspace';
    const root: FileEntry = {
      path: '',
      name: rootName,
      ext: '',
      size: 0,
      kind: 'unknown',
      isDirectory: true,
      children: [],
    };

    await this.scan(this.rootDir, root, 0);
    this.fileTree = root;
    return this.fileTree;
  }

  private async scan(dirPath: string, parent: FileEntry, depth: number): Promise<void> {
    if (!this.rootDir || depth > this.options.maxDepth || this.indexedFiles >= this.options.maxFiles) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (this.indexedFiles >= this.options.maxFiles) break;
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(this.rootDir, fullPath).split(path.sep).join('/');

      if (this.ignoredDirs.has(entry.name) && entry.isDirectory()) continue;
      if (this.ignoredFiles.has(entry.name)) continue;

      const fileEntry: FileEntry = {
        path: relativePath,
        name: entry.name,
        ext: entry.isDirectory() ? '' : path.extname(entry.name),
        size: 0,
        kind: this.classifyFile(entry.name, entry.isDirectory()),
        isDirectory: entry.isDirectory(),
      };

      if (entry.isDirectory()) {
        fileEntry.children = [];
        await this.scan(fullPath, fileEntry, depth + 1);
      } else {
        try {
          const stat = await fs.stat(fullPath);
          fileEntry.size = stat.size;
        } catch {}
        this.indexedFiles += 1;
      }

      parent.children!.push(fileEntry);
    }
  }

  private classifyFile(name: string, isDir: boolean): FileKind {
    if (isDir) return 'unknown';
    const ext = path.extname(name).toLowerCase();
    if (['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h'].includes(ext)) return 'source';
    if (['.json', '.yaml', '.yml', '.toml', '.env'].includes(ext)) return 'config';
    if (['.md', '.mdx', '.txt', '.rst'].includes(ext)) return 'document';
    if (['.png', '.jpg', '.gif', '.svg', '.ico', '.css'].includes(ext)) return 'asset';
    return 'unknown';
  }

  async getFile(filePath: string): Promise<FileEntry | null> {
    if (!this.fileTree) return null;
    return this.findFile(this.fileTree, normalizeWorkspacePath(filePath));
  }

  private findFile(root: FileEntry, targetPath: string): FileEntry | null {
    if (root.path === targetPath) return root;
    if (!root.children) return null;
    for (const child of root.children) {
      const found = this.findFile(child, targetPath);
      if (found) return found;
    }
    return null;
  }

  async readFile(filePath: string): Promise<string> {
    const absolutePath = await this.resolveWorkspaceFile(filePath);
    if (!absolutePath) return `[Could not read: ${filePath}]`;

    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size > this.options.maxFileSize) {
        return `[Could not read: ${filePath}]`;
      }
      return await fs.readFile(absolutePath, 'utf8');
    } catch {
      return `[Could not read: ${filePath}]`;
    }
  }

  async listFiles(pattern?: string): Promise<FileEntry[]> {
    if (!this.fileTree) return [];

    const results: FileEntry[] = [];
    this.collectFiles(this.fileTree, results);

    if (pattern) {
      const regex = this.patternToRegex(pattern);
      return results.filter((f) => regex.test(normalizeWorkspacePath(f.path)));
    }

    return results;
  }

  private collectFiles(entry: FileEntry, results: FileEntry[]): void {
    if (!entry.isDirectory) {
      results.push(entry);
    }
    if (entry.children) {
      for (const child of entry.children) {
        this.collectFiles(child, results);
      }
    }
  }

  private patternToRegex(pattern: string): RegExp {
    const normalizedPattern = normalizeWorkspacePath(pattern);
    const globStar = '\u0000';
    const escaped = normalizedPattern
      .replace(/\*\*/g, globStar)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(new RegExp(globStar, 'g'), '.*');
    return new RegExp(`^${escaped}$`, 'i');
  }

  private async resolveWorkspaceFile(filePath: string): Promise<string | null> {
    if (!this.rootDir || !this.rootRealPath || filePath.includes('\0') || path.isAbsolute(filePath)) {
      return null;
    }

    const rawSegments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (rawSegments.length === 0 || rawSegments.some((segment) => segment === '..' || this.ignoredDirs.has(segment))) {
      return null;
    }

    const absolutePath = path.resolve(this.rootDir, ...rawSegments);
    if (!isWithinRoot(this.rootDir, absolutePath)) {
      return null;
    }

    const realPath = await fs.realpath(absolutePath).catch(() => absolutePath);
    if (!isWithinRoot(this.rootRealPath, realPath)) {
      return null;
    }

    return absolutePath;
  }

  async generateRepoSummary(): Promise<string> {
    if (!this.fileTree) return 'No workspace indexed';

    const files = await this.listFiles();
    const byKind: Record<string, number> = {};
    const byExt: Record<string, number> = {};

    for (const f of files) {
      byKind[f.kind] = (byKind[f.kind] || 0) + 1;
      byExt[f.ext] = (byExt[f.ext] || 0) + 1;
    }

    const parts: string[] = [];
    parts.push(`Files: ${files.length}`);

    if (Object.keys(byKind).length) {
      parts.push(`By kind: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    const topExts = Object.entries(byExt)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `${k || 'dir'}=${v}`)
      .join(', ');

    if (topExts) {
      parts.push(`Top extensions: ${topExts}`);
    }

    return parts.join('\n');
  }
}

function normalizeWorkspacePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function isWithinRoot(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
