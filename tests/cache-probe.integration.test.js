import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashMaterialBank } from '../src/cache-source.js';
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

function makeProbe(warmupMode = 'prefix') {
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
      warmupMode,
      order: 'cold-warm',
      runSalt: RUN_SALT,
      bank: { name: 'chunked-samples', hash: hashMaterialBank(MATERIALS) },
      prefixValidation
    }
  };
}

async function runProbe(
  mode,
  {
    maxOutputTokens = 4,
    completionTokens = 1,
    warmupMode = 'prefix',
    concurrency = 1,
    concurrencyMode = 'batch',
    failContents = []
  } = {}
) {
  const probe = makeProbe(warmupMode);
  const server = await createMockSseServer({
    mode,
    prefixes: probe.units.map((unit) => unit.primed),
    hitDelayMs: 5,
    missDelayMs: 60,
    generationDelayMs: 3,
    completionTokens,
    failContents
  });
  const consoleOutput = vi.spyOn(console, 'log').mockImplementation(() => {});

  try {
    const results = await runLlmBenchmarkTest({
      url: server.url,
      model: 'mock-model',
      samples: probe.requestPlan.length,
      concurrency,
      concurrencyMode,
      maxOutputTokens,
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
    expect(run.results.raw.map((request) => request.cacheUnitIndex))
      .toEqual(run.requestPlan.map((request) => request.unitIndex));
    expect(run.consoleText).toContain('配对差值（热-冷）');
    expect(run.consoleText).toContain('Reason:');
  });

  it('model 模式先做模型预热，再串行 priming 所有前缀', async () => {
    const run = await runProbe('cache-aware', { warmupMode: 'model' });
    activeServer = run.server;
    const { requests } = run.server;
    const firstPrefixWarmup = 1;

    expect(requests[0].firstUserContent).toMatch(/^\[c-model-warmup-[0-9a-f-]{36}\]/);
    expect(requests.slice(firstPrefixWarmup, firstPrefixWarmup + run.units.length)
      .map((request) => request.firstUserContent))
      .toEqual(run.units.map((unit) => unit.primed));
    expect(requests.slice(firstPrefixWarmup, firstPrefixWarmup + run.units.length)
      .every((request) => request.cacheHit === false)).toBe(true);
    expect(requests).toHaveLength(1 + run.units.length + run.requestPlan.length);
  });

  it('cache probe rejects warmup-mode none before sending requests', async () => {
    const probe = makeProbe('none');

    await expect(runLlmBenchmarkTest({
      cacheProbe: probe.cacheProbe
    })).rejects.toThrow('缓存探针必须预热前缀，请使用默认 prefix 或 model');
  });

  it('cache-aware usage 报告命中并测得 warm TTFT 更低', async () => {
    const run = await runProbe('cache-aware');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(cache.verdict).toBe('benefit');
    expect(cache.reason).toBe('consistent-benefit');
    expect(cache.server.tokenHitRate).toBeGreaterThan(0);
    expect(cache.warm.median).toBeLessThan(cache.cold.median);
    expect(run.server.requests.filter((request) => request.cacheHit)).toHaveLength(run.units.length);
    expect(run.consoleText).toContain('缓存命中探针:');
  });

  it.each(['pipeline', 'batch'])(
    'concurrency=2 的 %s 并发分支保留配对元数据且先完成全部预热',
    async (concurrencyMode) => {
      const run = await runProbe('cache-aware', {
        concurrency: 2,
        concurrencyMode
      });
      activeServer = run.server;
      const unitCount = run.units.length;
      const timedRequests = run.server.requests.slice(unitCount);
      const orderedResults = [...run.results.raw]
        .sort((left, right) => left.requestIndex - right.requestIndex);

      expect(run.server.maxConcurrent).toBeGreaterThanOrEqual(2);
      expect(run.server.requests.slice(0, unitCount).map((request) => request.firstUserContent))
        .toEqual(run.units.map((unit) => unit.primed));
      expect(timedRequests).toHaveLength(run.requestPlan.length);
      expect(timedRequests.map((request) => request.firstUserContent).sort())
        .toEqual(run.requestPlan.map((request) => request.text).sort());
      expect(run.server.requests).toHaveLength(unitCount + run.requestPlan.length);

      expect(orderedResults.map((request) => request.cacheIntent))
        .toEqual(run.requestPlan.map((request) => request.intent));
      expect(orderedResults.map((request) => request.cacheUnitIndex))
        .toEqual(run.requestPlan.map((request) => request.unitIndex));
      expect(orderedResults.map((request) => request.cacheUnitIndex))
        .toEqual(run.units.flatMap((unit) => [unit.unitIndex, unit.unitIndex]));
      expect(run.results.metrics.cache.pairDeltas).toHaveLength(unitCount);
      expect(run.results.metrics.cache.verdict).toBe('benefit');
    }
  );

  it('no-usage 的行为对比不依赖客户端 token 估算且不误报响应缓存', async () => {
    const run = await runProbe('no-usage');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(cache.server).toBeNull();
    expect(cache.verdict).toBe('benefit');
    expect(cache.reason).toBe('consistent-benefit');
    expect(cache.warm.median).toBeLessThan(cache.cold.median);
    expect(cache.responseCacheSuspected).toBe(0);
  });

  it('usage 缺少缓存字段时 server 为 null 且按冷热 TTFT 行为判定', async () => {
    const run = await runProbe('usage-no-cache');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(cache.server).toBeNull();
    expect(cache.verdict).toBe('benefit');
    expect(cache.reason).toBe('consistent-benefit');
    expect(cache.warm.median).toBeLessThan(cache.cold.median);
    expect(cache.responseCacheSuspected).toBe(0);
  });

  it('服务端未提供 prompt_tokens 时不把客户端输入估算计入缓存命中率', async () => {
    const run = await runProbe('cache-without-prompt');
    activeServer = run.server;
    const cache = run.results.metrics.cache;

    expect(run.results.raw.every((request) => request.promptTokens === null)).toBe(true);
    expect(run.results.raw.every((request) => request.cachedPromptTokens === 0)).toBe(true);
    expect(run.results.raw.every((request) => request.inputTokens > 0)).toBe(true);
    expect(cache.server).toEqual({
      cachedPromptTokens: 0,
      promptTokens: 0,
      tokenHitRate: null,
      requestsWithData: 0,
      source: 'api'
    });
    expect(cache.verdict).toBe('benefit');
    expect(cache.reason).toBe('consistent-benefit');
  });

  it('retains cache unit metadata on successful and failed timed requests', async () => {
    const probe = makeProbe();
    const failedText = probe.units[0].cold;
    const run = await runProbe('cache-aware', { failContents: [failedText] });
    activeServer = run.server;

    const failedCold = run.results.failed.find((request) => request.requestIndex === 0);
    const successfulWarm = run.results.raw.find((request) => (
      request.requestIndex === 1
    ));

    expect(failedCold).toMatchObject({
      success: false,
      cacheIntent: 'miss',
      cacheUnitIndex: 0
    });
    expect(successfulWarm).toMatchObject({
      cacheIntent: 'hit',
      cacheUnitIndex: 0
    });
  });

  it('truncatedRequests 按 completion_tokens 是否触及 max_tokens 计数', async () => {
    const truncatedRun = await runProbe('cache-aware', {
      maxOutputTokens: 1,
      completionTokens: 1
    });
    activeServer = truncatedRun.server;

    expect(truncatedRun.results.raw.map((request) => request.outputTokens))
      .toEqual(Array(truncatedRun.requestPlan.length).fill(1));
    expect(truncatedRun.results.metrics.cache.truncatedRequests)
      .toBe(truncatedRun.requestPlan.length);
    expect(truncatedRun.consoleText).toContain(
      `⚠️ ${truncatedRun.requestPlan.length} 条请求输出被 max_tokens 截断`
    );

    await activeServer.close();
    activeServer = null;

    const completeRun = await runProbe('cache-aware', {
      maxOutputTokens: 8,
      completionTokens: 3
    });
    activeServer = completeRun.server;

    expect(completeRun.results.raw.map((request) => request.outputTokens))
      .toEqual(Array(completeRun.requestPlan.length).fill(3));
    expect(completeRun.results.metrics.cache.truncatedRequests).toBe(0);
    expect(completeRun.consoleText).not.toContain('输出被 max_tokens 截断');
    expect(completeRun.consoleText).not.toContain('疑似响应级缓存');
  });

  it('控制台在检测到疑似响应级缓存时显示诊断提示', async () => {
    const run = await runProbe('cache-aware', { completionTokens: 0 });
    activeServer = run.server;

    expect(run.results.metrics.cache.responseCacheSuspected)
      .toBe(run.requestPlan.length);
    expect(run.consoleText).toContain(
      `⚠️ 疑似响应级缓存 ${run.requestPlan.length} 条：TPS/解码类指标可能无效`
    );
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
    expect(cache.reason).toBe('server-reports-zero');
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
    expect(run.results.config.bank).toEqual({
      name: 'chunked-samples',
      hash: hashMaterialBank(MATERIALS)
    });
    expect(run.results.config.prefixValidation).toEqual(run.prefixValidation);
    expect(run.results.raw.map((request) => request.cacheIntent))
      .toEqual(run.requestPlan.map((request) => request.intent));
  });
});
