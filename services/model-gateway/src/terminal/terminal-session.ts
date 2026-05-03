import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface TerminalSessionInfo {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  createdAt: string;
  exitedAt: string | null;
}

export class TerminalSession extends EventEmitter {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly createdAt: string;
  private process: ChildProcess | null = null;
  private _status: TerminalSessionInfo['status'] = 'running';
  private _exitCode: number | null = null;
  private _exitedAt: string | null = null;
  private outputBuffer: string[] = [];
  private readonly maxOutputLines: number;

  constructor(
    id: string,
    command: string,
    cwd: string,
    maxOutputLines = 1000,
  ) {
    super();
    this.id = id;
    this.command = command;
    this.cwd = cwd;
    this.createdAt = new Date().toISOString();
    this.maxOutputLines = maxOutputLines;
  }

  start(): void {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/c', this.command] : ['-c', this.command];

    this.process = spawn(shell, shellArgs, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.appendOutput(text);
      this.emit('output', text);
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.appendOutput(text);
      this.emit('output', text);
    });

    this.process.on('error', (err) => {
      const msg = `\n[Terminal error: ${err.message}]\n`;
      this.appendOutput(msg);
      this.emit('output', msg);
    });

    this.process.on('exit', (code) => {
      this._exitCode = code;
      this._exitedAt = new Date().toISOString();
      if (this._status === 'killed') {
        this.appendOutput(`\n[Process killed by user]\n`);
      } else {
        this._status = 'exited';
        this.appendOutput(`\n[Process exited with code ${code}]\n`);
      }
      this.emit('exit', code);
    });
  }

  write(data: string): void {
    if (!this.process || this._status !== 'running') {
      return;
    }
    this.process.stdin?.write(data);
  }

  kill(): void {
    if (!this.process || this._status !== 'running') {
      return;
    }
    this._status = 'killed';
    this.process.kill('SIGTERM');
    setTimeout(() => {
      if (this.process && this.process.exitCode === null) {
        this.process.kill('SIGKILL');
      }
    }, 3000);
  }

  get status(): TerminalSessionInfo['status'] {
    return this._status;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get exitedAt(): string | null {
    return this._exitedAt;
  }

  /**
   * Backward-compatible alias for the typo that existed in earlier builds.
   */
  get exittedAt(): string | null {
    return this._exitedAt;
  }

  getInfo(): TerminalSessionInfo {
    return {
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      status: this._status,
      exitCode: this._exitCode,
      createdAt: this.createdAt,
      exitedAt: this._exitedAt,
    };
  }

  getOutput(): string {
    return this.outputBuffer.join('');
  }

  getOutputLines(maxLines?: number): string {
    const tail = maxLines ? this.outputBuffer.slice(-maxLines) : this.outputBuffer;
    return tail.join('');
  }

  private appendOutput(text: string): void {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      this.outputBuffer.push(line + '\n');
    }
    while (this.outputBuffer.length > this.maxOutputLines) {
      this.outputBuffer.shift();
    }
  }
}

export class TerminalSessionService {
  private sessions: Map<string, TerminalSession> = new Map();
  private workspaceRoot: string;
  private readonly maxSessions: number;
  private readonly maxCommandLength: number;

  constructor(workspaceRoot: string, maxSessions = 5, maxCommandLength = 5000) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.maxSessions = maxSessions;
    this.maxCommandLength = maxCommandLength;
  }

  setWorkspaceRoot(rootDir: string): void {
    this.workspaceRoot = path.resolve(rootDir);
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  createSession(command: string): TerminalSession {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Maximum terminal sessions reached (${this.maxSessions})`);
    }

    const normalized = command.trim();
    if (!normalized || normalized.length > this.maxCommandLength || /[\0\r\u2028\u2029]/.test(normalized)) {
      throw new Error('Terminal command is invalid or too large');
    }

    const id = randomUUID();
    const session = new TerminalSession(id, normalized, this.workspaceRoot);
    this.sessions.set(id, session);

    session.on('exit', () => {
      this.sessions.delete(id);
    });

    session.start();
    return session;
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  killSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.kill();
    return true;
  }

  listSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo());
  }

  getAllOutput(): string {
    const outputs: string[] = [];
    for (const session of this.sessions.values()) {
      const info = session.getInfo();
      outputs.push(`\n--- Terminal session ${session.id} (${info.command}) [${info.status}] ---\n`);
      outputs.push(session.getOutputLines(200));
    }
    return outputs.join('');
  }
}
