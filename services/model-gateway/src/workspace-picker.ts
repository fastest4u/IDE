import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WorkspacePickerErrorCode =
  | 'WORKSPACE_PICKER_CANCELLED'
  | 'WORKSPACE_PICKER_UNAVAILABLE'
  | 'WORKSPACE_PICKER_FAILED';

export class WorkspacePickerError extends Error {
  constructor(
    message: string,
    readonly code: WorkspacePickerErrorCode,
  ) {
    super(message);
    this.name = 'WorkspacePickerError';
  }
}

export interface WorkspacePickerService {
  pickDirectory(defaultPath?: string): Promise<string>;
}

export class NativeWorkspacePickerService implements WorkspacePickerService {
  async pickDirectory(defaultPath?: string): Promise<string> {
    switch (process.platform) {
      case 'darwin':
        return this.pickDirectoryMacOS(defaultPath);
      case 'win32':
        return this.pickDirectoryWindows(defaultPath);
      case 'linux':
        return this.pickDirectoryLinux(defaultPath);
      default:
        throw new WorkspacePickerError(`Workspace picker is not supported on platform: ${process.platform}`, 'WORKSPACE_PICKER_UNAVAILABLE');
    }
  }

  private async pickDirectoryMacOS(defaultPath?: string): Promise<string> {
    const lines = defaultPath?.trim()
      ? [
          `set selectedFolder to choose folder with prompt ${JSON.stringify('Select Workspace')} default location POSIX file ${JSON.stringify(defaultPath)}`,
          'POSIX path of selectedFolder',
        ]
      : [
          `set selectedFolder to choose folder with prompt ${JSON.stringify('Select Workspace')}`,
          'POSIX path of selectedFolder',
        ];

    try {
      const { stdout } = await execFileAsync('osascript', lines.flatMap((line) => ['-e', line]), {
        encoding: 'utf8',
        timeout: 300_000,
      });
      return normalizePickedPath(stdout);
    } catch (err) {
      throw mapPickerError(err, 'osascript');
    }
  }

  private async pickDirectoryWindows(defaultPath?: string): Promise<string> {
    const command = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$dialog.Description = ${toPowerShellString('Select Workspace')}`,
      '$dialog.ShowNewFolderButton = $false',
      ...(defaultPath?.trim() ? [`$dialog.SelectedPath = ${toPowerShellString(defaultPath)}`] : []),
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      '  Write-Output $dialog.SelectedPath',
      '} else {',
      '  exit 2',
      '}',
    ].join('; ');

    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-Command', command], {
        encoding: 'utf8',
        timeout: 300_000,
      });
      return normalizePickedPath(stdout);
    } catch (err) {
      throw mapPickerError(err, 'powershell');
    }
  }

  private async pickDirectoryLinux(defaultPath?: string): Promise<string> {
    const normalizedDefaultPath = defaultPath?.trim() ? ensureTrailingSeparator(defaultPath) : undefined;

    try {
      const { stdout } = await execFileAsync(
        'zenity',
        [
          '--file-selection',
          '--directory',
          '--title=Select Workspace',
          ...(normalizedDefaultPath ? [`--filename=${normalizedDefaultPath}`] : []),
        ],
        {
          encoding: 'utf8',
          timeout: 300_000,
        },
      );
      return normalizePickedPath(stdout);
    } catch (err) {
      if (isMissingCommandError(err)) {
        try {
          const { stdout } = await execFileAsync(
            'kdialog',
            [
              '--getexistingdirectory',
              normalizedDefaultPath ?? path.sep,
              '--title',
              'Select Workspace',
            ],
            {
              encoding: 'utf8',
              timeout: 300_000,
            },
          );
          return normalizePickedPath(stdout);
        } catch (fallbackErr) {
          throw mapPickerError(fallbackErr, 'kdialog');
        }
      }

      throw mapPickerError(err, 'zenity');
    }
  }
}

function normalizePickedPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new WorkspacePickerError('Workspace picker was cancelled', 'WORKSPACE_PICKER_CANCELLED');
  }
  return path.resolve(trimmed);
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isMissingCommandError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

function mapPickerError(err: unknown, commandName: string): WorkspacePickerError {
  if (err instanceof WorkspacePickerError) {
    return err;
  }

  if (isMissingCommandError(err)) {
    return new WorkspacePickerError(`Workspace picker command is unavailable: ${commandName}`, 'WORKSPACE_PICKER_UNAVAILABLE');
  }

  if (isExecCancelError(err)) {
    return new WorkspacePickerError('Workspace picker was cancelled', 'WORKSPACE_PICKER_CANCELLED');
  }

  if (err instanceof Error) {
    return new WorkspacePickerError(err.message, 'WORKSPACE_PICKER_FAILED');
  }

  return new WorkspacePickerError(`Workspace picker failed via ${commandName}`, 'WORKSPACE_PICKER_FAILED');
}

function isExecCancelError(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error) || !('code' in err)) {
    return false;
  }

  const nodeErr = err as NodeJS.ErrnoException;
  const code = (nodeErr as { code?: string | number }).code;
  const message = `${nodeErr.message ?? ''} ${(nodeErr as { stderr?: string }).stderr ?? ''}`.toLowerCase();
  return code === 1 || code === 2 || code === '1' || code === '2' || message.includes('cancel') || message.includes('user canceled');
}
