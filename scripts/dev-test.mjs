import { spawn } from 'node:child_process';
import process from 'node:process';

const workspaceRoot = process.env.IDE_WORKSPACE_ROOT ?? process.cwd();
const gatewayUrl = process.env.IDE_GATEWAY_URL ?? 'http://127.0.0.1:3001';

function spawnCommand(command, args, label) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });

  child.on('exit', (code) => {
    console.log(`[${label}] exited with code ${code ?? 0}`);
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });

  return child;
}

async function waitForGateway(tries = 60) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(`${gatewayUrl}/health`);
      if (response.ok) return;
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Gateway did not become healthy at ${gatewayUrl}`);
}

async function indexWorkspace() {
  const response = await fetch(`${gatewayUrl}/workspace/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootDir: workspaceRoot }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Workspace index failed: ${response.status} ${body}`.trim());
  }
}

const gateway = spawnCommand('pnpm', ['dev:model-gateway'], 'gateway');

process.on('SIGINT', () => {
  gateway.kill('SIGINT');
  web?.kill('SIGINT');
  process.exit(130);
});
process.on('SIGTERM', () => {
  gateway.kill('SIGTERM');
  web?.kill('SIGTERM');
  process.exit(143);
});

let web = null;

try {
  await waitForGateway();
  await indexWorkspace();
  web = spawnCommand('pnpm', ['dev:web'], 'web');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  gateway.kill('SIGTERM');
  process.exit(1);
}
