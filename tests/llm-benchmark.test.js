import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { measureTokenSpeed, processTokenSpeedResult } from '../src/llm-benchmark.js';
import { createSimplePromptVariant } from '../src/default-prompts.js';

const mockedHttpClient = vi.hoisted(() => ({
  post: vi.fn()
}));

vi.mock('../src/http-client.js', async () => {
  const actual = await vi.importActual('../src/http-client.js');
  return {
    ...actual,
    createHttpClient: vi.fn(() => mockedHttpClient)
  };
});

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
  beforeEach(() => {
    mockedHttpClient.post.mockReset();
  });

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

  describe('runLlmBenchmarkTest', () => {
    it('should force warmup requests to use simple prompts in dynamic sample mode', async () => {
      const recordedBodies = [];

      mockedHttpClient.post.mockImplementation(async (_url, body) => {
        recordedBodies.push(body);
        const stream = new EventEmitter();
        setTimeout(() => {
          stream.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n'));
          stream.emit('data', Buffer.from('data: {"usage":{"prompt_tokens":8,"completion_tokens":1}}\n'));
          stream.emit('end');
        }, 0);
        return { data: stream };
      });

      const { runLlmBenchmarkTest } = await import('../src/llm-benchmark.js');

      await runLlmBenchmarkTest({
        url: 'https://api.example.com',
        model: 'test-model',
        generateInputText: async () => 'SAMPLE_CONTENT_SHOULD_NOT_APPEAR',
        sampleCount: 3,
        warmupRequests: 1,
        samples: 1,
        concurrency: 1,
        maxOutputTokens: 16,
        quiet: true
      });

      expect(recordedBodies).toHaveLength(2);
      expect(recordedBodies[0].messages).toHaveLength(1);
      expect(recordedBodies[0].messages[0].content).not.toContain('SAMPLE_CONTENT_SHOULD_NOT_APPEAR');
      expect(recordedBodies[0].messages[0].content).toContain('1000 token 以内');
      expect(recordedBodies[1].messages[0].content).toBe('SAMPLE_CONTENT_SHOULD_NOT_APPEAR');
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

    it('should treat reasoning_content as first token data', async () => {
      const result = await measureTokenSpeed(
        createMockClient([
          'data: {"choices":[{"delta":{"reasoning_content":"先想一想"}}]}\n',
          'data: {"choices":[{"delta":{"content":"最终答案"}}]}\n',
          'data: {"timings":{"prompt_n":10,"predicted_n":6}}\n'
        ]),
        'https://api.example.com',
        'test-agent',
        'test-model',
        [{ role: 'user', content: 'hello world' }],
        32
      );

      expect(result.ttft).not.toBeNull();
      expect(result.visibleTtft).not.toBeNull();
      expect(result.ttft).toBeLessThanOrEqual(result.visibleTtft);
      expect(result.outputText).toBe('最终答案');
      expect(result.allOutputText).toBe('先想一想最终答案');
    });

    it('should still use reasoning_content when reasoning is an empty container', async () => {
      const result = await measureTokenSpeed(
        createMockClient([
          'data: {"choices":[{"delta":{"reasoning":[],"reasoning_content":"先返回思考"}}]}\n',
          'data: {"choices":[{"delta":{"content":"最终答案"}}]}\n',
          'data: {"timings":{"prompt_n":10,"predicted_n":6}}\n'
        ]),
        'https://api.example.com',
        'test-agent',
        'test-model',
        [{ role: 'user', content: 'hello world' }],
        32
      );

      expect(result.ttft).not.toBeNull();
      expect(result.visibleTtft).not.toBeNull();
      expect(result.ttft).toBeLessThanOrEqual(result.visibleTtft);
      expect(result.allOutputText).toBe('先返回思考最终答案');
    });

    it('should support array content deltas as visible output', async () => {
      const result = await measureTokenSpeed(
        createMockClient([
          'data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"Hello"},{"type":"output_text","text":" world"}]}}]}\n',
          'data: {"usage":{"prompt_tokens":9,"completion_tokens":2}}\n'
        ]),
        'https://api.example.com',
        'test-agent',
        'test-model',
        [{ role: 'user', content: 'hello world' }],
        32
      );

      expect(result.ttft).not.toBeNull();
      expect(result.visibleTtft).not.toBeNull();
      expect(result.outputText).toBe('Hello world');
      expect(result.allOutputText).toBe('Hello world');
    });

    it('should support array content deltas that use delta fields', async () => {
      const result = await measureTokenSpeed(
        createMockClient([
          'data: {"choices":[{"delta":{"content":[{"type":"output_text_delta","delta":"Hello"},{"type":"output_text_delta","delta":" world"}]}}]}\n',
          'data: {"usage":{"prompt_tokens":9,"completion_tokens":2}}\n'
        ]),
        'https://api.example.com',
        'test-agent',
        'test-model',
        [{ role: 'user', content: 'hello world' }],
        32
      );

      expect(result.ttft).not.toBeNull();
      expect(result.visibleTtft).not.toBeNull();
      expect(result.outputText).toBe('Hello world');
      expect(result.allOutputText).toBe('Hello world');
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
          reasoningOutputTokens: 20,
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
          reasoningOutputTokens: 10,
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
      expect(processed.metrics.outputTokens.total).toBe(200);
      expect(processed.metrics.reasoningOutputTokens.total).toBe(30);
      expect(processed.metrics.reasoningOutputTokens.mean).toBe(15);
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
