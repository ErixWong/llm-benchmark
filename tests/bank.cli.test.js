import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [indexPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_BASE_URL: 'http://127.0.0.1:1/v1',
        API_MODEL: 'bank-cli-test',
        SAMPLE_COUNT: '0',
        CACHE_PROBE: 'false',
        BANK: '',
        ...env
      },
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe('bank CLI', () => {
  it('prints bank metadata and selected item in dry-run mode', async () => {
    const result = await runCli(['--bank', 'poems', '-c', '1', '-r', '1', '-n', '0', '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('题库名称/版本: poems / 1');
    expect(result.stdout).toContain('题库条目数: 30');
    expect(result.stdout).toContain('题库分层计数:');
    expect(result.stdout).toContain('请求 #1 素材:');
    expect(result.stdout).toContain('配置验证通过');
  });

  it('loads the bank named by the BANK environment variable', async () => {
    const result = await runCli(['-c', '1', '-r', '1', '-n', '0', '--dry-run'], { BANK: 'poems' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('题库名称/版本: poems / 1');
  });

  it('uses explicit bank IDs instead of the seeded selection', async () => {
    const result = await runCli([
      '--bank',
      'poems',
      '--bank-items',
      'wujue-jingyesi',
      '-c',
      '1',
      '-r',
      '1',
      '-n',
      '0',
      '--dry-run'
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('请求 #1 素材: wujue-jingyesi');
    expect(result.stderr).toContain('--bank-items 已指定');
  });

  it('rejects incompatible sample and cache-probe sources', async () => {
    const sampleConflict = await runCli([
      '--bank',
      'poems',
      '-n',
      '1',
      '--dry-run'
    ]);
    expect(sampleConflict.code).toBe(1);
    expect(sampleConflict.stderr).toContain('--bank 与 -n N（N > 0）素材来源互斥');

    const probeConflict = await runCli([
      '--bank',
      'poems',
      '--cache-probe',
      '-n',
      '0',
      '--dry-run'
    ]);
    expect(probeConflict.code).toBe(1);
    expect(probeConflict.stderr).toContain('题库暂不支持缓存探针场景');
  });
});
