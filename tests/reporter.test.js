import { describe, it, expect } from 'vitest';
import { normalizeReportResults, prepareChartData, getReportDisplayTime, formatSecondsFromMs, getPrimaryTokenSource, getFailureSummary, getReportSummary, getTokenMetricCards, getInputTokenDisplay } from '../src/reporter.js';

describe('reporter', () => {
  it('should preserve top-level fields when normalizing token-speed results', () => {
    const normalized = normalizeReportResults({
      type: 'token-speed',
      reportTitle: 'Demo',
      extraMeta: 'keep-me'
    });

    expect(normalized.tokenSpeed.type).toBe('token-speed');
    expect(normalized.extraMeta).toBe('keep-me');
  });

  it('should use test timestamp for report display time', () => {
    const displayTime = getReportDisplayTime({
      tokenSpeed: {
        timestamp: '2026-07-05T02:00:00.000Z'
      }
    });

    expect(displayTime).toContain('2026');
  });

  it('should format ttft values in seconds', () => {
    expect(formatSecondsFromMs(41096)).toBe('41.10 s');
    expect(formatSecondsFromMs(null)).toBe('N/A');
  });

  it('should keep failed requests in chart labels and pad values with null', () => {
    const chartData = prepareChartData({
      tokenSpeed: {
        success: true,
        metrics: {
          tps: { mean: 20, requestMean: 15, median: 10, min: 5, max: 30 },
          ttft: { mean: 1000, median: 1000, min: 1000, max: 1000 },
          outputTokens: { mean: 100, median: 100 },
          requestTime: { mean: 2000, median: 2000 }
        },
        raw: [
          { success: true, requestIndex: 0, tps: 20, ttft: 1000, outputTokens: 100, inputTokens: 50, totalRequestTime: 2000, requestSendTime: 1000, responseReceiveTime: 3000 }
        ],
        failed: [
          { success: false, requestIndex: 1, error: 'timeout', requestSendTime: 1100, responseReceiveTime: 2100 }
        ]
      }
    });

    expect(chartData.tokenSpeed.labels).toEqual(['请求 1', '请求 2']);
    expect(chartData.tokenSpeed.tps).toEqual([20, null]);
    expect(chartData.tokenSpeed.outputTokens).toEqual([100, null]);
  });

  it('should extract primary token source from raw results', () => {
    expect(getPrimaryTokenSource({
      tokenSpeed: {
        raw: [{ tokenSource: 'api-timings' }]
      }
    })).toBe('api-timings');
  });

  it('should build failure summary', () => {
    const failureSummary = getFailureSummary({
      tokenSpeed: {
        errors: {
          total: 2,
          rate: '25.00'
        }
      }
    });

    expect(failureSummary.hasFailures).toBe(true);
    expect(failureSummary.label).toContain('失败 2 个请求');
  });

  it('should build report summary with token source and metrics', () => {
    const summary = getReportSummary({
      tokenSpeed: {
        success: true,
        config: { model: 'qwen3.6:35b' },
        metrics: {
          ttft: { mean: 726 },
          tps: { mean: 113.3 }
        },
        errors: { total: 0, rate: '0.00' },
        raw: [{ tokenSource: 'api-timings' }]
      }
    });

    expect(summary).toContain('api-timings');
    expect(summary).toContain('113.3 tokens/s');
  });

  it('should distinguish server and visible token cards', () => {
    const cards = getTokenMetricCards({
      tokenSpeed: {
        success: true,
        metrics: {
          outputTokens: { mean: 1983 },
          visibleOutputTokens: { mean: 3346 }
        }
      }
    });

    expect(cards.primaryOutputLabel).toBe('服务端输出Tokens');
    expect(cards.secondaryOutputLabel).toBe('可见文本Tokens');
  });

  it('should expose configured and actual input token display data', () => {
    const inputTokenDisplay = getInputTokenDisplay({
      tokenSpeed: {
        success: true,
        config: { inputTokens: 45 },
        metrics: {
          inputTokens: {
            mean: 4,
            min: 4,
            max: 4,
            median: 4
          }
        }
      }
    });

    expect(inputTokenDisplay.configured).toBe(45);
    expect(inputTokenDisplay.actualMean).toBe(4);
    expect(inputTokenDisplay.hasMeaningfulDrift).toBe(true);
  });
});
