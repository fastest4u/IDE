import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const processes = [];

function start(command, args, label, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  processes.push({ child, label });
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[dev] ${label} exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
      for (const proc of processes) {
        if (proc.child.pid && proc.child.pid !== child.pid) {
          proc.child.kill('SIGTERM');
        }
      }
      process.exit(code ?? 1);
    }
  });
  return child;
}

async function waitForGateway(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const gateway = start('pnpm', ['--dir', 'services/model-gateway', 'dev'], 'model-gateway');
await waitForGateway('http://127.0.0.1:3001/health');
start('pnpm', ['dev:web'], 'web');

process.on('SIGINT', () => {
  for (const proc of processes) {
    proc.child.kill('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const proc of processes) {
    proc.child.kill('SIGTERM');
  }
  process.exit(0);
});

await gateway;
