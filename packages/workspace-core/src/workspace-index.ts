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

type GlobPattern = (entry: FileEntry) => boolean;

export class InMemoryWorkspaceIndex implements WorkspaceIndex {
  private fileTree: FileEntry | null = null;
  private fileCache = new Map<string, string>();
  private readonly ignoredDirs = new Set([
    'node_modules', '.git', '.turbo', 'dist', 'build', '.next',
    '__pycache__', '.obsidian', '.DS_Store',
  ]);
  private readonly ignoredFiles = new Set([
    '.DS_Store', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json',
  ]);

  async indexDirectory(rootDir: string): Promise<FileEntry> {
    this.fileCache.clear();

    const rootName = path.basename(rootDir) || 'workspace';
    const root: FileEntry = {
      path: rootDir,
      name: rootName,
      ext: '',
      size: 0,
      kind: 'unknown',
      isDirectory: true,
      children: [],
    };

    await this.scan(rootDir, root);
    this.fileTree = root;
    return this.fileTree;
  }

  private async scan(dirPath: string, parent: FileEntry): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (this.ignoredDirs.has(entry.name) && entry.isDirectory()) continue;
      if (this.ignoredFiles.has(entry.name)) continue;

      const fileEntry: FileEntry = {
        path: fullPath,
        name: entry.name,
        ext: entry.isDirectory() ? '' : path.extname(entry.name),
        size: 0,
        kind: this.classifyFile(entry.name, entry.isDirectory()),
        isDirectory: entry.isDirectory(),
      };

      if (entry.isDirectory()) {
        fileEntry.children = [];
        await this.scan(fullPath, fileEntry);
      } else {
        try {
          const stat = await fs.stat(fullPath);
          fileEntry.size = stat.size;
        } catch {}
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
    return this.findFile(this.fileTree, filePath);
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
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath) ?? '';
    }

    try {
      const content = await fs.readFile(filePath, 'utf8');
      this.fileCache.set(filePath, content);
      return content;
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
      return results.filter((f) => regex.test(f.path));
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
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
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
