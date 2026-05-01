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
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 4096;

function isWithinRoot(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelativePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/');
}

function hasDeniedPathSegment(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => DENIED_PATH_SEGMENTS.has(segment) || segment === '..' || segment === '.');
}

export class WorkspaceWriter {
  private rootDir: string;
  private readonly fileLocks = new Map<string, Promise<void>>();

  constructor(rootDir = process.cwd(), private readonly maxReadBytes = DEFAULT_MAX_READ_BYTES) {
    this.rootDir = path.resolve(rootDir);
  }

  setWorkspaceRoot(rootDir: string): void {
    this.rootDir = path.resolve(rootDir);
  }

  getWorkspaceRoot(): string {
    return this.rootDir;
  }

  resolvePath(filePath: string): GuardedWorkspacePath {
    const rawPath = normalizeRelativePath(filePath);
    if (!rawPath || rawPath.includes('\0')) {
      throw new WorkspacePathError('Patch target path is empty or invalid');
    }
    if (rawPath.length > MAX_PATH_LENGTH) {
      throw new WorkspacePathError('Patch target path is too long');
    }
    if (path.isAbsolute(rawPath)) {
      throw new WorkspacePathError('Patch target path must be workspace-relative');
    }

    const normalizedRelativePath = path.posix.normalize(rawPath);
    if (!normalizedRelativePath || normalizedRelativePath === '.' || normalizedRelativePath.startsWith('../') || normalizedRelativePath.includes('/../')) {
      throw new WorkspacePathError(`Patch target escapes workspace root: ${filePath}`);
    }
    if (hasDeniedPathSegment(normalizedRelativePath)) {
      throw new WorkspacePathError(`Patch target uses a protected workspace path: ${normalizedRelativePath}`);
    }

    const absolutePath = path.resolve(this.rootDir, normalizedRelativePath);

    if (!isWithinRoot(this.rootDir, absolutePath)) {
      throw new WorkspacePathError(`Patch target escapes workspace root: ${filePath}`);
    }

    return { absolutePath, relativePath: normalizedRelativePath };
  }

  async readFile(filePath: string): Promise<string | null> {
    const guardedPath = this.resolvePath(filePath);
    await this.assertRealPathWithinWorkspace(guardedPath.absolutePath, false);

    try {
      await this.assertFileSizeWithinLimit(guardedPath.absolutePath);
      return await fs.readFile(guardedPath.absolutePath, 'utf8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return null;
      }
      if (isNodeError(err) && err.code === 'EISDIR') {
        throw new WorkspacePathError(`Patch target is a directory, not a file: ${guardedPath.relativePath}`);
      }
      throw err;
    }
  }

  async writeFile(filePath: string, content: string, expectedContent?: string): Promise<void> {
    const guardedPath = this.resolvePath(filePath);
    await this.withFileLock(guardedPath.absolutePath, async () => {
      await this.assertRealPathWithinWorkspace(guardedPath.absolutePath, true);
      if (expectedContent !== undefined) {
        const currentContent = await this.readFile(guardedPath.relativePath);
        if ((currentContent ?? '') !== expectedContent) {
          throw new WorkspacePathError(`Workspace file changed since it was loaded: ${guardedPath.relativePath}`, 'WORKSPACE_WRITE_CONFLICT');
        }
      }

      await fs.mkdir(path.dirname(guardedPath.absolutePath), { recursive: true });
      const tempPath = `${guardedPath.absolutePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, guardedPath.absolutePath);
    });
  }

  async deleteFile(filePath: string, expectedContent?: string): Promise<void> {
    const guardedPath = this.resolvePath(filePath);
    await this.withFileLock(guardedPath.absolutePath, async () => {
      await this.assertRealPathWithinWorkspace(guardedPath.absolutePath, false);
      if (expectedContent !== undefined) {
        const currentContent = await this.readFile(guardedPath.relativePath);
        if ((currentContent ?? '') !== expectedContent) {
          throw new WorkspacePathError(`Workspace file changed since it was loaded: ${guardedPath.relativePath}`, 'WORKSPACE_WRITE_CONFLICT');
        }
      }

      try {
        await fs.unlink(guardedPath.absolutePath);
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          return;
        }
        throw err;
      }
    });
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
      const stat = await fs.lstat(pathToCheck);
      if (stat.isSymbolicLink()) {
        throw new WorkspacePathError(`Patch target cannot be a symlink: ${pathToCheck}`);
      }
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
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new WorkspacePathError(`Patch target parent cannot traverse symlink: ${current}`);
        }
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

  private async assertFileSizeWithinLimit(absolutePath: string): Promise<void> {
    const stat = await fs.stat(absolutePath);
    if (stat.isFile() && stat.size > this.maxReadBytes) {
      throw new WorkspacePathError(`Workspace file is too large to read safely: ${absolutePath}`, 'WORKSPACE_FILE_TOO_LARGE');
    }
  }

  private async withFileLock<T>(absolutePath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(absolutePath) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.fileLocks.set(absolutePath, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.fileLocks.get(absolutePath) === next) {
        this.fileLocks.delete(absolutePath);
      }
    }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
