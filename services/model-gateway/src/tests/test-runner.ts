import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = resolve(__dirname, '../tests');

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

const tests = [
  { name: 'Production Safety', file: 'production-safety.test.ts' },
  { name: 'Crash Recovery', file: 'crash-recovery.test.ts' },
  { name: 'Approval Recovery', file: 'approval-recovery.test.ts' },
  { name: 'Workflow Approval Recovery', file: 'workflow-approval-recovery.test.ts' },
  { name: 'Patch Recovery', file: 'patch-recovery.test.ts' },
  { name: 'Terminal Recovery', file: 'terminal-recovery.test.ts' },
];

async function runTest(name: string, file: string): Promise<TestResult> {
  const start = Date.now();
  return new Promise((resolveTest) => {
    const child = spawn('npx', ['tsx', resolve(testDir, file)], {
      stdio: 'pipe',
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('exit', (code) => {
      const durationMs = Date.now() - start;
      const passed = code === 0;

      if (passed) {
        // Show summary from test output
        const lastLines = stdout.split('\n').slice(-5).filter(Boolean);
        for (const line of lastLines) {
          console.log(`    ${line.trim()}`);
        }
      }

      resolveTest({
        name,
        passed,
        durationMs,
        error: !passed ? (stderr.split('\n').slice(-3).join('\n') || `exit code ${code}`) : undefined,
      });
    });

    child.on('error', (err) => {
      resolveTest({
        name,
        passed: false,
        durationMs: Date.now() - start,
        error: err.message,
      });
    });
  });
}

async function main() {
  const results: TestResult[] = [];

  console.log('\n🧪  Recovery Test Suite\n');
  console.log(`Running ${tests.length} tests...\n`);

  for (const test of tests) {
    console.log(`  ▶ ${test.name}...`);
    const result = await runTest(test.name, test.file);
    results.push(result);

    if (result.passed) {
      console.log(`  ✅ ${test.name} (${(result.durationMs / 1000).toFixed(1)}s)\n`);
    } else {
      console.log(`  ❌ ${test.name} (${(result.durationMs / 1000).toFixed(1)}s)`);
      if (result.error) {
        console.log(`     ${result.error.split('\n').map(l => `     ${l}`).join('\n')}`);
      }
      console.log('');
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log('═══════════════════════════════════════════');
  console.log(`  Results: ${passed}/${results.length} passed`);
  console.log(`  Duration: ${(totalMs / 1000).toFixed(1)}s`);
  if (failed > 0) {
    console.log(`  Failed:`);
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`    - ${r.name}`);
    }
  }
  console.log('═══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(2);
});
