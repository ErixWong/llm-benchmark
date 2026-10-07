import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateReport } from '../src/reporter.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const SECRET_VISIBLE = 'SECRET-VISIBLE-OUTPUT';
const SECRET_REASONING = 'SECRET-REASONING';

function makeRequest(i) {
  return {
    success: true,
    requestIndex: i,
    requestSendTime: 1700000000000 + i * 1000,
    responseReceiveTime: 1700000005000 + i * 1000,
    totalRequestTime: 5000 + i,
    ttft: 100 + i,
    ttfo: 2000 + i,
    outputTokens: 256 + i,
    reasoningTokens: 200 + i,
    contentTokens: 56,
    inputTokens: 1000,
    generationTime: 4900,
    tps: 52.3,
    tokenSource: 'api',
    reasoningTokenSource: 'api',
    outputText: SECRET_VISIBLE.repeat(50),
    reasoningText: SECRET_REASONING.repeat(50)
  };
}

function makeResults() {
  return {
    reportTitle: 'T</script><b>x',
    tokenSpeed: {
      type: 'token-speed',
      success: true,
      timestamp: new Date().toISOString(),
      config: {
        model: 'evil"><script>alert(1)</script>',
        url: 'http://x/<script>alert(2)</script>',
        inputTokens: 1000,
        maxOutputTokens: 256,
        concurrency: 4,
        concurrencyMode: 'pipeline',
        samples: 3,
        totalTime: 20000,
        sampleCount: 0
      },
      metrics: {
        tps: { mean: 52, min: 50, max: 55, median: 52, values: [52, 53, 55] },
        throughputTps: 38.4,
        ttft: { mean: 101, min: 100, max: 102, median: 101, values: [100, 101, 102] },
        ttfo: { mean: 2001, min: 2000, max: 2002, median: 2001, values: [2000, 2001, 2002] },
        outputTokens: { mean: 257, min: 256, max: 258, median: 257 },
        reasoningTokens: { mean: 201, total: 603, values: [200, 201, 202] },
        contentTokens: { mean: 56, total: 168, values: [56, 56, 56] },
        tokenSource: { api: 3, tokenizer: 0 },
        requestTime: { mean: 5001, min: 5000, max: 5002, median: 5001 }
      },
      errors: {
        total: 1,
        rate: '25.00',
        details: [{ requestIndex: 0, error: '</script><script>alert(3)</script>' }]
      },
      raw: [makeRequest(0), makeRequest(1), makeRequest(2)],
      failed: [{
        success: false,
        requestIndex: 3,
        requestSendTime: 1700000001000,
        responseReceiveTime: 1700000002000,
        error: '</script><script>alert(3)</script>'
      }]
    }
  };
}

function makeCacheResults() {
  const results = makeResults();
  results.tokenSpeed.config.samples = 6;
  results.tokenSpeed.config.units = [{
    unitIndex: 0,
    itemId: 'sample-1',
    prefixHash: 'abcdef123456',
    prefixTokens: 100
  }];
  results.tokenSpeed.config.prefixValidation = {
    unique: { ok: true },
    verified: 1
  };
  results.tokenSpeed.metrics.cache = {
    cold: { n: 3, median: 120, min: 110, max: 130 },
    warm: { n: 3, median: 20, min: 15, max: 25 },
    ttftDeltaMs: 100,
    ttftRatio: 6,
    pairDeltas: [-100, -100, -100],
    pairsTotal: 3,
    pairsFavorable: 3,
    pairsUnfavorable: 0,
    pairsTied: 0,
    pairedMedianDeltaMs: -100,
    insufficientSamples: false,
    server: {
      cachedPromptTokens: 300,
      promptTokens: 600,
      tokenHitRate: 0.5,
      requestsWithData: 6,
      source: 'api'
    },
    verdict: 'benefit',
    reason: 'consistent-benefit',
    responseCacheSuspected: 0,
    truncatedRequests: 0
  };
  return results;
}

async function readReport(dir) {
  const files = await fs.readdir(dir);
  const read = async (ext) => {
    const file = files.find(f => f.endsWith(ext));
    return file ? fs.readFile(path.join(dir, file), 'utf8') : '';
  };
  return { json: await read('.json'), md: await read('.md'), html: await read('.html') };
}

describe('reporter', () => {
  let tmpDir;
  let report;
  let fixture;
  let originalIncludeText;

  beforeAll(async () => {
    originalIncludeText = process.env.REPORT_INCLUDE_TEXT;
    delete process.env.REPORT_INCLUDE_TEXT;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-bench-report-'));
    fixture = makeResults();
    await generateReport(fixture, tmpDir);
    report = await readReport(tmpDir);
  });

  afterAll(async () => {
    if (originalIncludeText !== undefined) {
      process.env.REPORT_INCLUDE_TEXT = originalIncludeText;
    } else {
      delete process.env.REPORT_INCLUDE_TEXT;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('JSON 报告', () => {
    it('写入 metricsVersion', () => {
      expect(JSON.parse(report.json).metricsVersion).toBe(1.1);
    });

    it('默认剥离模型输出全文', () => {
      expect(report.json).not.toContain(SECRET_VISIBLE);
      expect(report.json).not.toContain(SECRET_REASONING);
    });

    it('剥离后仍保留数值字段', () => {
      const parsed = JSON.parse(report.json);
      const first = parsed.tokenSpeed.raw[0];
      expect(first.ttfo).toBe(2000);
      expect(first.tps).toBe(52.3);
      expect(first.tokenSource).toBe('api');
    });

    it('不修改传入的结果对象（内存中仍保留文本）', () => {
      expect(fixture.tokenSpeed.raw[0].outputText).toContain(SECRET_VISIBLE);
      expect(fixture.tokenSpeed.raw[0].reasoningText).toContain(SECRET_REASONING);
    });

    it('保留缓存指标与配置中的前缀信息', async () => {
      const results = makeCacheResults();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-bench-report-cache-'));
      try {
        await generateReport(results, dir);
        const { json } = await readReport(dir);
        const parsed = JSON.parse(json);
        expect(parsed.tokenSpeed.metrics.cache.server.tokenHitRate).toBe(0.5);
        expect(parsed.tokenSpeed.config.units[0]).toMatchObject({
          prefixHash: 'abcdef123456',
          prefixTokens: 100
        });
        expect(parsed.tokenSpeed.raw[0].outputText).toBeUndefined();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('REPORT_INCLUDE_TEXT', () => {
    it('为 true 时保留全文', async () => {
      const results = makeResults();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-bench-report-text-'));
      process.env.REPORT_INCLUDE_TEXT = 'true';
      try {
        await generateReport(results, dir);
        const { json } = await readReport(dir);
        expect(json).toContain(SECRET_VISIBLE);
      } finally {
        delete process.env.REPORT_INCLUDE_TEXT;
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('HTML 注入防护', () => {
    it('不出现未转义的脚本载荷', () => {
      expect(report.html).not.toContain('<script>alert');
      expect(report.html).not.toContain('</script><script>alert');
      expect(report.html).not.toContain('"><script>');
    });

    it('HTML 上下文中模型名与 URL 被转义', () => {
      expect(report.html).toContain('&lt;script&gt;alert(2)');
      expect(report.html).toContain('&lt;script&gt;alert(1)');
    });

    it('script 上下文中的 JSON 被转义', () => {
      expect(report.html).toContain('\\u003cscript\\u003ealert(3)');
    });
  });

  describe('Markdown 报告', () => {
    it('包含 TTFO 与 token 来源，且不含已移除的解码总吞吐', () => {
      expect(report.md).toContain('TTFO');
      expect(report.md).toContain('Token 计数来源');
      expect(report.md).not.toContain('解码总吞吐');
    });

    it('包含推理/内容 token 拆分', () => {
      expect(report.md).toContain('推理Token 平均');
      expect(report.md).toContain('内容Token 平均');
    });

    it('错误详情中的 HTML 被中和', () => {
      expect(report.md).not.toContain('</script><script>alert');
      expect(report.md).toContain('&lt;script&gt;alert(3)');
    });

    it('普通报告不添加缓存区块', () => {
      expect(report.md).not.toContain('### 缓存命中');
      expect(report.html).not.toContain('class="cache-probe"');
    });

    it('探针报告包含冷热统计、服务端覆盖率及前缀自检', async () => {
      const results = makeCacheResults();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-bench-report-cache-'));
      try {
        await generateReport(results, dir);
        const { md, html } = await readReport(dir);
        expect(md).toContain('### 缓存命中');
        expect(md).toContain('120 ms（n=3）');
        expect(md).toContain('冷组 TTFT min / max | 110 ms / 130 ms');
        expect(md).toContain('20 ms（n=3）');
        expect(md).toContain('热组 TTFT min / max | 15 ms / 25 ms');
        expect(md).toContain('冷-热 TTFT 差值（中位数之差）');
        expect(md).toContain('6.00×');
        expect(md).toContain('配对差值（热-冷，按单元） | -100 ms, -100 ms, -100 ms');
        expect(md).toContain('一致有利配对 | 3/3');
        expect(md).toContain('观察到缓存收益');
        expect(md).toContain('配对差值一致支持收益');
        expect(md).toContain('50.00%');
        expect(md).toContain('6/6');
        expect(md).toContain('唯一性 通过；预热前缀匹配 1/1');
        expect(md).not.toContain('prefill 耗时');
        expect(html).toContain('class="card cache-probe"');
        expect(html).toContain('服务端 token 命中率');
        expect(html).toContain('一致有利配对');
        expect(html).toContain('配对差值一致支持收益');
        expect(html).toContain('唯一性 通过；预热前缀匹配 1/1');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('服务端未报告缓存字段或样本不足时写明结论限制', async () => {
      const results = makeCacheResults();
      results.tokenSpeed.metrics.cache.server = null;
      results.tokenSpeed.metrics.cache.insufficientSamples = true;
      results.tokenSpeed.metrics.cache.verdict = 'inconclusive';
      results.tokenSpeed.metrics.cache.reason = 'insufficient-samples';
      results.tokenSpeed.metrics.cache.pairDeltas = [-100, -100];
      results.tokenSpeed.metrics.cache.pairsTotal = 2;
      results.tokenSpeed.metrics.cache.pairsFavorable = 2;
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-bench-report-cache-'));
      try {
        await generateReport(results, dir);
        const { md, html } = await readReport(dir);
        expect(md).toContain('服务端未上报缓存字段；结论依据为成对 TTFT 行为');
        expect(md).toContain('样本不足，不做结论');
        expect(md).toContain('结论不确定');
        expect(html).toContain('服务端未上报缓存字段；结论依据为成对 TTFT 行为');
        expect(html).toContain('样本不足，不做结论');
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
