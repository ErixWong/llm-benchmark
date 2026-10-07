import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProbeUnits, checkUniquePrefixes, verifyPrefix } from '../src/cache-probe.js';
import { buildRequestPlan } from '../src/cache-plan.js';
import { runLlmBenchmarkTest } from '../src/llm-benchmark.js';
import { createMockSseServer } from './helpers/mock-sse-server.js';

const MATERIALS = Array.from({ length: 3 }, (_, index) => ({
  id: `material-${index + 1}`,
  text: `## Stable prefix ${index + 1}\n${`Prefix material ${index + 1} remains identical. `.repeat(30)}`,
  tokens: 150
}));
const RUN_SALT = 'wxyz';
const SUFFIX = '\n\nSummarize the material.';

function makeProbe() {
  const units = buildProbeUnits({
    materials: MATERIALS,
    suffix: SUFFIX,
    runSalt: RUN_SALT
  });
  const unique = checkUniquePrefixes(units);
  const checks = units.map((unit) => verifyPrefix(unit.primed, unit.warm));
  const prefixValidation = {
    unique,
    verified: checks.filter((check) => check.ok).length,
    total: units.length,
    ok: unique.ok && checks.every((check) => check.ok)
  };
  const requestPlan = buildRequestPlan(units);
  return {
    units,
    requestPlan,
    prefixValidation,
    cacheProbe: {
      units,
      suffix: SUFFIX,
      warmupMode: 'prefix',
      order: 'cold-warm',
      runSalt: RUN_SALT,
      prefixValidation
    }
  };
}

async function runProbe(mode) {
  const probe = makeProbe();
  const server = await createMockSseServer({
    mode,
    prefixes: probe.units.map((unit) => unit.primed),
    hitDelayMs: 5,
    missDelayMs: 60,
    generationDelayMs: 3
  });
  const consoleOutput = vi.spyOn(console, 'log').mockImplementation(() => {});

  try {
    const results = await runLlmBenchmarkTest({
      url: server.url,
      model: 'mock-model',
      samples: probe.requestPlan.length,
      concurrency: 1,
      concurrencyMode: 'batch',
      maxOutputTokens: 4,
      timeout: 3000,
      retry: 0,
      requestPlan: probe.requestPlan,
      cacheProbe: probe.cacheProbe,
      cacheSeed: 7,
      prefixTokens: Math.max(...probe.units.map((unit) => unit.prefixTokens)),
      runSalt: RUN_SALT
    });

    return {
      ...probe,
      results,
      server,
      consoleText: consoleOutput.mock.calls.map(([line]) => String(line)).join('\n')
    };
  } catch (error) {
    await server.close();
    throw error;
  } finally {
    consoleOutput.mockRestore();
  }
}

let activeServer;

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

describe('cache-probe integration', () => {
  it('串行预热所有前缀后按 cold/warm 成对发送，且两组仅 nonce 不同', async () => {
    const run = await runProbe('cache-aware');
    activeServer = run.server;
    const { requests } = run.server;
    const unitCount = run.units.length;

    expect(requests.slice(0, unitCount).map((request) => request.firstUserContent))
      .toEqual(run.units.map((unit) => unit.primed));
    expect(requests.slice(unitCount).map((request) => request.firstUserContent))
      .toEqual(run.requestPlan.map((request) => request.text));

    for (let index = 0; index < run.units.length; index += 1) {
      const unit = run.units[index];
      const cold = requests[unitCount + index * 2].firstUserContent;
      const warm = requests[unitCount + index * 2 + 1].firstUserContent;
      expect(cold.replace(unit.coldNonce, unit.warmNonce)).toBe(warm);
      expect(cold.slice(unit.coldNonce.length)).toBe(warm.slice(unit.warmNonce.length));
    }

    expect(requests.map((request) => request.order)).toEqual(
      requests.map((_, index) => index)
    );
    expect(run.results.raw.map((request) => request.cacheIntent))
      .toEqual(run.requestPlan.map((request) => request.intent));
  });

  it('cache-aware usage 报告命中并测得 warm TTFT 更低', async () => {
    const run = await runProbe('cache-aware');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(cache.verdict).toBe('benefit');
    expect(cache.server.tokenHitRate).toBeGreaterThan(0);
    expect(cache.warm.median).toBeLessThan(cache.cold.median);
    expect(run.server.requests.filter((request) => request.cacheHit)).toHaveLength(run.units.length);
    expect(run.consoleText).toContain('缓存命中探针:');
  });

  it('no-usage 的行为对比不依赖客户端 token 估算且不误报响应缓存', async () => {
    const run = await runProbe('no-usage');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(cache.server).toBeNull();
    expect(cache.verdict).toBe('benefit');
    expect(cache.warm.median).toBeLessThan(cache.cold.median);
    expect(cache.responseCacheSuspected).toBe(0);
  });

  it('usage 缺少缓存字段时 server 为 null 且按冷热 TTFT 行为判定', async () => {
    const run = await runProbe('usage-no-cache');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(cache.server).toBeNull();
    expect(cache.verdict).toBe('benefit');
    expect(cache.warm.median).toBeLessThan(cache.cold.median);
    expect(cache.responseCacheSuspected).toBe(0);
  });

  it('显式 cached_tokens: 0 时以服务端零命中为准，即使 warm TTFT 更低', async () => {
    const run = await runProbe('usage-explicit-zero-cache');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(cache.server).not.toBeNull();
    expect(cache.server.requestsWithData).toBeGreaterThan(0);
    expect(cache.server.tokenHitRate).toBe(0);
    expect(cache.warm.median).toBeLessThan(cache.cold.median);
    expect(cache.verdict).toBe('no-benefit');
  });

  it('配置包含每单元前缀摘要且计时请求保留正确 cacheIntent', async () => {
    const run = await runProbe('cache-aware');
    activeServer = run.server;
    const configUnits = run.results.config.units;

    expect(configUnits).toHaveLength(run.units.length);
    expect(configUnits).toEqual(run.units.map((unit) => ({
      unitIndex: unit.unitIndex,
      itemId: unit.itemId,
      prefixHash: unit.prefixHash,
      prefixTokens: unit.prefixTokens
    })));
    expect(run.results.config.prefixValidation).toEqual(run.prefixValidation);
    expect(run.results.raw.map((request) => request.cacheIntent))
      .toEqual(run.requestPlan.map((request) => request.intent));
  });
});
