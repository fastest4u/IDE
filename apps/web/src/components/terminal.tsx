import React, { useEffect, useRef, useState, useCallback } from 'react';

interface TerminalSessionInfo {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  createdAt: string;
  exitedAt: string | null;
}

const GATEWAY_URL = 'http://127.0.0.1:3001';

export function useTerminalOutput(): string {
  const [output, setOutput] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/terminal/output`);
      const body = (await res.json()) as { output: string };
      setOutput(body.output);
    } catch {
      // gateway may be offline
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return output;
}

export function Terminal() {
  const [command, setCommand] = useState('');
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const appendLine = useCallback((text: string) => {
    setLines((prev) => {
      const next = [...prev, text];
      if (next.length > 2000) {
        return next.slice(-1000);
      }
      return next;
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

  const streamSession = useCallback(
    (sessionId: string) => {
      eventSourceRef.current?.close();
      const es = new EventSource(`${GATEWAY_URL}/terminal/${sessionId}/stream`);
      eventSourceRef.current = es;

      es.addEventListener('output', (event: MessageEvent) => {
        const payload = JSON.parse(event.data) as { type: string; text: string };
        appendLine(payload.text);
      });

      es.addEventListener('exit', (event: MessageEvent) => {
        const payload = JSON.parse(event.data) as { type: string; code: number | null };
        appendLine(`\n[Process exited with code ${payload.code}]\n`);
        setSession((prev) =>
          prev ? { ...prev, status: 'exited', exitCode: payload.code } : null,
        );
        es.close();
        eventSourceRef.current = null;
      });

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
      };
    },
    [appendLine],
  );

  const handleExec = async () => {
    const cmd = command.trim();
    if (!cmd || isConnecting) return;

    setIsConnecting(true);
    setLines([]);
    setSession(null);

    try {
      const res = await fetch(`${GATEWAY_URL}/terminal/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });

      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        appendLine(`Error: ${err.error}\n`);
        setIsConnecting(false);
        return;
      }

      const body = (await res.json()) as { session: TerminalSessionInfo };
      setSession(body.session);
      appendLine(`$ ${cmd}\n`);
      streamSession(body.session.id);
    } catch (err) {
      appendLine(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleKill = async () => {
    if (!session || session.status !== 'running') return;

    try {
      await fetch(`${GATEWAY_URL}/terminal/${session.id}/kill`, { method: 'POST' });
      setSession((prev) => (prev ? { ...prev, status: 'killed' } : null));
    } catch {
      // ignore
    }
  };

  const handleRestart = async () => {
    if (!session) return;

    try {
      const res = await fetch(`${GATEWAY_URL}/terminal/${session.id}/restart`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: session.command }),
      });

      if (!res.ok) {
        const err = (await res.json()) as { error: string };
        appendLine(`Error: ${err.error}\n`);
        return;
      }

      const body = (await res.json()) as { session: TerminalSessionInfo };
      setLines([]);
      setSession(body.session);
      appendLine(`$ ${body.session.command}\n`);
      streamSession(body.session.id);
    } catch (err) {
      appendLine(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleExec();
    }
  };

  return (
    <footer className="app-shell__terminal">
      <div className="app-shell__terminal-header">
        <div className="app-shell__terminal-session">
          <span className="app-shell__terminal-shell">zsh</span>
          <span className="app-shell__terminal-session-meta">{session?.command || 'Ready'}</span>
        </div>
        <div className="app-shell__terminal-actions">
          {session && (
            <span className={`app-shell__terminal-status app-shell__terminal-status--${session.status}`}>
              {session.status}
              {session.exitCode !== null && session.status !== 'running' ? ` (${session.exitCode})` : ''}
            </span>
          )}
          {session?.status === 'running' && (
            <button
              type="button"
              className="app-shell__ghost-button"
              onClick={() => void handleKill()}
            >
              Kill
            </button>
          )}
          {session && session.status !== 'running' && (
            <button
              type="button"
              className="app-shell__ghost-button"
              onClick={() => void handleRestart()}
            >
              Restart
            </button>
          )}
        </div>
      </div>
      <pre className="app-shell__terminal-output" ref={outputRef}>
        {lines.length === 0 && !session && 'Run a command to see terminal output here.'}
        {lines.map((line, i) => (
          <React.Fragment key={i}>{line}</React.Fragment>
        ))}
      </pre>
      <div className="app-shell__terminal-input-row">
        <span className="app-shell__terminal-prompt">$</span>
        <input
          ref={inputRef}
          type="text"
          className="app-shell__terminal-input"
          placeholder="pnpm build"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isConnecting}
        />
        <button
          type="button"
          className="app-shell__ghost-button"
          onClick={() => void handleExec()}
          disabled={isConnecting || !command.trim()}
        >
          {isConnecting ? '...' : 'Run'}
        </button>
      </div>
    </footer>
  );
}
