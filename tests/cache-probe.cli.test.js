import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe('cache-probe CLI', () => {
  it('validates prefixes and exits successfully in dry-run mode', async () => {
    const result = await runCli([
      indexPath,
      '--cache-probe',
      '--dry-run',
      '-c',
      '1',
      '-r',
      '1',
      '-n',
      '0',
      '--prefix-tokens',
      '64'
    ], {
      ...process.env,
      API_BASE_URL: 'http://127.0.0.1:1/v1',
      API_MODEL: 'preflight-smoke-model'
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout + result.stderr).toContain('前缀自检');
  });
});
