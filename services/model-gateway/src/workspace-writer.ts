import { promises as fs } from 'node:fs';
import path from 'node:path';

export class WorkspacePathError extends Error {
  constructor(
    message: string,
    readonly code = 'PATCH_PATH_DENIED',
  ) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export interface GuardedWorkspacePath {
  absolutePath: string;
  relativePath: string;
}

const DENIED_PATH_SEGMENTS = new Set(['.git', 'node_modules']);

function isWithinRoot(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class WorkspaceWriter {
  private rootDir: string;

  constructor(rootDir = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
  }

  setWorkspaceRoot(rootDir: string): void {
    this.rootDir = path.resolve(rootDir);
  }

  getWorkspaceRoot(): string {
    return this.rootDir;
  }

  resolvePath(filePath: string): GuardedWorkspacePath {
    const rawPath = filePath.trim();
    if (!rawPath || rawPath.includes('\0')) {
      throw new WorkspacePathError('Patch target path is empty or invalid');
    }

    if (path.isAbsolute(rawPath)) {
      throw new WorkspacePathError('Patch target path must be workspace-relative');
    }

    const absolutePath = path.resolve(this.rootDir, rawPath);

    if (!isWithinRoot(this.rootDir, absolutePath)) {
      throw new WorkspacePathError(`Patch target escapes workspace root: ${filePath}`);
    }

    const relativePath = path.relative(this.rootDir, absolutePath).split(path.sep).join('/');
    if (!relativePath || relativePath === '.') {
      throw new WorkspacePathError('Patch target cannot be the workspace root');
    }

    const segments = relativePath.split('/');
    if (segments.some((segment) => DENIED_PATH_SEGMENTS.has(segment))) {
      throw new WorkspacePathError(`Patch target uses a protected workspace path: ${relativePath}`);
    }

    return { absolutePath, relativePath };
  }

  async readFile(filePath: string): Promise<string | null> {
    const guardedPath = this.resolvePath(filePath);
    await this.assertRealPathWithinWorkspace(guardedPath.absolutePath, false);

    try {
      return await fs.readFile(guardedPath.absolutePath, 'utf8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const guardedPath = this.resolvePath(filePath);
    await this.assertRealPathWithinWorkspace(guardedPath.absolutePath, true);
    await fs.mkdir(path.dirname(guardedPath.absolutePath), { recursive: true });
    await fs.writeFile(guardedPath.absolutePath, content, 'utf8');
  }

  async deleteFile(filePath: string): Promise<void> {
    const guardedPath = this.resolvePath(filePath);
    await this.assertRealPathWithinWorkspace(guardedPath.absolutePath, false);

    try {
      await fs.unlink(guardedPath.absolutePath);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  private async assertRealPathWithinWorkspace(
    absolutePath: string,
    allowMissingLeaf: boolean,
  ): Promise<void> {
    const rootRealPath = await fs.realpath(this.rootDir).catch(() => this.rootDir);
    const pathToCheck = allowMissingLeaf
      ? await this.findExistingPathOrParent(absolutePath)
      : absolutePath;

    try {
      const realPath = await fs.realpath(pathToCheck);
      if (!isWithinRoot(rootRealPath, realPath)) {
        throw new WorkspacePathError(`Patch target resolves outside workspace root: ${absolutePath}`);
      }
    } catch (err) {
      if (allowMissingLeaf && isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      if (!allowMissingLeaf && isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  private async findNearestExistingParent(startDir: string): Promise<string> {
    let current = startDir;
    while (isWithinRoot(this.rootDir, current)) {
      try {
        const stat = await fs.stat(current);
        if (stat.isDirectory()) {
          return current;
        }
      } catch (err) {
        if (!isNodeError(err) || err.code !== 'ENOENT') {
          throw err;
        }
      }

      const next = path.dirname(current);
      if (next === current) {
        break;
      }
      current = next;
    }

    throw new WorkspacePathError(`Patch target parent is outside workspace root: ${startDir}`);
  }

  private async findExistingPathOrParent(absolutePath: string): Promise<string> {
    try {
      await fs.lstat(absolutePath);
      return absolutePath;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }

    return this.findNearestExistingParent(path.dirname(absolutePath));
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
