import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { measureTokenSpeed, processTokenSpeedResult } from '../src/llm-benchmark.js';
import { createSimplePromptVariant } from '../src/default-prompts.js';

function createMockClient(chunks) {
  return {
    post: async () => {
      const stream = new EventEmitter();
      setTimeout(() => {
        for (const chunk of chunks) {
          stream.emit('data', Buffer.from(chunk));
        }
        stream.emit('end');
      }, 0);
      return { data: stream };
    }
  };
}

describe('llm-benchmark', () => {
  describe('default prompt generation', () => {
    it('should generate bounded non-sample prompts with output limit guidance', () => {
      const prompts = Array.from({ length: 8 }, () => createSimplePromptVariant());

      for (const prompt of prompts) {
        expect(prompt).toContain('1000 token 以内');
        expect(prompt.length).toBeGreaterThan(20);
      }

      expect(new Set(prompts).size).toBeGreaterThan(1);
    });
  });

  describe('measureTokenSpeed', () => {
    it('should use usage token counts when api returns usage', async () => {
      const result = await measureTokenSpeed(
        createMockClient([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
          'data: {"usage":{"prompt_tokens":11,"completion_tokens":7}}\n'
        ]),
        'https://api.example.com',
        'test-agent',
        'test-model',
        [{ role: 'user', content: 'hello world' }],
        32
      );

      expect(result.tokenSource).toBe('api-usage');
      expect(result.inputTokens).toBe(11);
      expect(result.outputTokens).toBe(7);
    });

    it('should use timings token counts when api returns timings', async () => {
      const result = await measureTokenSpeed(
        createMockClient([
          'data: {"choices":[{"delta":{"content":"测试"}}]}\n',
          'data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}],"timings":{"prompt_n":23,"predicted_n":8}}\n'
        ]),
        'https://api.example.com',
        'test-agent',
        'test-model',
        [{ role: 'user', content: 'hello world' }],
        32
      );

      expect(result.tokenSource).toBe('api-timings');
      expect(result.inputTokens).toBe(23);
      expect(result.outputTokens).toBe(8);
    });
  });

  describe('processTokenSpeedResult', () => {
    it('should compute weighted TPS separately from per-request mean', () => {
      const results = [
        {
          success: true,
          tps: 10,
          ttft: 100,
          visibleTtft: 120,
          inputTokens: 40,
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
          inputTokens: 60,
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
      expect(processed.metrics.inputTokens.mean).toBe(50);
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

    it('should fallback to total request time when generation time is zero', () => {
      const results = [
        {
          success: true,
          tps: 40,
          ttft: 100,
          visibleTtft: 100,
          outputTokens: 40,
          visibleOutputTokens: 40,
          totalRequestTime: 1000,
          generationTime: 1000,
          requestSendTime: 1000,
          responseReceiveTime: 2000
        },
        {
          success: true,
          tps: 10,
          ttft: 500,
          visibleTtft: 500,
          outputTokens: 20,
          visibleOutputTokens: 20,
          totalRequestTime: 2000,
          generationTime: 2000,
          requestSendTime: 1000,
          responseReceiveTime: 3000
        }
      ];

      const processed = processTokenSpeedResult(results, {
        totalTime: 4000,
        samples: 2,
        concurrency: 1,
        concurrencyMode: 'batch'
      });

      expect(processed.metrics.tps.requestMean).toBe(25);
      expect(processed.metrics.tps.mean).toBeCloseTo(60 / 3, 5);
    });

    it('should exclude zero generation times from weighted denominator when there is no output', () => {
      const results = [
        {
          success: true,
          tps: 0,
          ttft: null,
          visibleTtft: null,
          outputTokens: 0,
          visibleOutputTokens: 0,
          totalRequestTime: 500,
          generationTime: 0,
          requestSendTime: 1000,
          responseReceiveTime: 1500
        },
        {
          success: true,
          tps: 20,
          ttft: 100,
          visibleTtft: 100,
          outputTokens: 40,
          visibleOutputTokens: 40,
          totalRequestTime: 2000,
          generationTime: 2000,
          requestSendTime: 1000,
          responseReceiveTime: 3000
        }
      ];

      const processed = processTokenSpeedResult(results, {
        totalTime: 4000,
        samples: 2,
        concurrency: 1,
        concurrencyMode: 'batch'
      });

      expect(processed.metrics.tps.mean).toBeCloseTo(20, 5);
      expect(processed.metrics.tps.requestMean).toBe(10);
    });
  });
});
