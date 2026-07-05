import { describe, it, expect } from 'vitest';
import { processTokenSpeedResult } from '../src/llm-benchmark.js';

describe('llm-benchmark', () => {
  describe('processTokenSpeedResult', () => {
    it('should compute weighted TPS separately from per-request mean', () => {
      const results = [
        {
          success: true,
          tps: 10,
          ttft: 100,
          visibleTtft: 120,
          outputTokens: 100,
          visibleOutputTokens: 80,
          totalRequestTime: 1200,
          generationTime: 10000,
          requestSendTime: 1000,
          responseReceiveTime: 2200
        },
        {
          success: true,
          tps: 50,
          ttft: 150,
          visibleTtft: 180,
          outputTokens: 100,
          visibleOutputTokens: 90,
          totalRequestTime: 350,
          generationTime: 2000,
          requestSendTime: 1100,
          responseReceiveTime: 1450
        }
      ];

      const processed = processTokenSpeedResult(results, {
        totalTime: 15000,
        samples: 2,
        concurrency: 2,
        concurrencyMode: 'pipeline'
      });

      expect(processed.metrics.tps.requestMean).toBe(30);
      expect(processed.metrics.tps.mean).toBeCloseTo(200 / 12, 5);
      expect(processed.metrics.throughputTps).toBeCloseTo(200 / 15, 5);
      expect(processed.metrics.visibleTtft.mean).toBe(150);
      expect(processed.metrics.visibleOutputTokens.mean).toBe(85);
    });

    it('should keep failed request details and safe stats', () => {
      const results = [
        {
          success: true,
          tps: 20,
          ttft: 200,
          visibleTtft: 220,
          outputTokens: 40,
          visibleOutputTokens: 40,
          totalRequestTime: 1000,
          generationTime: 2000,
          requestSendTime: 1000,
          responseReceiveTime: 2000
        },
        {
          success: false,
          requestIndex: 1,
          error: 'timeout'
        }
      ];

      const processed = processTokenSpeedResult(results, {
        totalTime: 4000,
        samples: 2,
        concurrency: 1,
        concurrencyMode: 'batch'
      });

      expect(processed.errors.total).toBe(1);
      expect(processed.errors.rate).toBe('50.00');
      expect(processed.errors.details).toEqual([{ requestIndex: 1, error: 'timeout' }]);
      expect(processed.metrics.ttft.min).toBe(200);
      expect(processed.metrics.ttft.max).toBe(200);
    });
  });
});
