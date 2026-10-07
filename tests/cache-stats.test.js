import { describe, it, expect } from 'vitest';
import {
  extractCacheUsage,
  isTruncated,
  summarizeCache
} from '../src/cache-stats.js';

const cacheRequest = (cacheIntent, ttft, fields = {}) => ({
  success: true,
  cacheIntent,
  ttft,
  ...fields
});

const groupedRequests = (coldTtft, warmTtft, fields = {}) => [
  ...coldTtft.map((ttft) => cacheRequest('miss', ttft, fields)),
  ...warmTtft.map((ttft) => cacheRequest('hit', ttft, fields))
];

describe('cache-stats', () => {
  describe('extractCacheUsage', () => {
    it.each([
      [
        'OpenAI / vLLM / SGLang / Azure',
        { prompt_tokens_details: { cached_tokens: 12 } }
      ],
      ['DeepSeek', { prompt_cache_hit_tokens: 12 }],
      ['Anthropic', { cache_read_input_tokens: 12 }],
      ['Gemini', { usage_metadata: { cached_content_token_count: 12 } }]
    ])('extracts the %s field', (_vendor, usage) => {
      expect(extractCacheUsage(usage, 20)).toEqual({
        cachedPromptTokens: 12,
        source: 'api'
      });
    });

    it('uses vendor-field priority and does not fall through an invalid higher-priority field', () => {
      expect(extractCacheUsage({
        prompt_tokens_details: { cached_tokens: 4 },
        prompt_cache_hit_tokens: 8
      }, 20)).toEqual({ cachedPromptTokens: 4, source: 'api' });
      expect(extractCacheUsage({
        prompt_tokens_details: { cached_tokens: '4' },
        prompt_cache_hit_tokens: 8
      }, 20)).toEqual({ cachedPromptTokens: null, source: 'unknown' });
    });

    it.each([
      ['missing', {}, 20],
      ['string value', { prompt_tokens_details: { cached_tokens: '12' } }, 20],
      ['negative value', { prompt_tokens_details: { cached_tokens: -1 } }, 20],
      ['value over known prompt tokens', { prompt_tokens_details: { cached_tokens: 21 } }, 20],
      ['null value', { prompt_tokens_details: { cached_tokens: null } }, 20]
    ])('returns unknown for a %s', (_case, usage, promptTokens) => {
      expect(extractCacheUsage(usage, promptTokens)).toEqual({
        cachedPromptTokens: null,
        source: 'unknown'
      });
    });

    it('does not bound a cache count when promptTokens is unknown', () => {
      expect(extractCacheUsage({ prompt_cache_hit_tokens: 25 }, null)).toEqual({
        cachedPromptTokens: 25,
        source: 'api'
      });
      expect(extractCacheUsage({ prompt_cache_hit_tokens: 25 }, undefined)).toEqual({
        cachedPromptTokens: 25,
        source: 'api'
      });
    });
  });

  describe('isTruncated', () => {
    it('requires equal positive numeric token counts', () => {
      expect(isTruncated({ outputTokens: 10, maxOutputTokens: 10 })).toBe(true);
      expect(isTruncated({ outputTokens: 9, maxOutputTokens: 10 })).toBe(false);
      expect(isTruncated({ outputTokens: 0, maxOutputTokens: 0 })).toBe(false);
      expect(isTruncated({ outputTokens: 10, maxOutputTokens: '10' })).toBe(false);
      expect(isTruncated({})).toBe(false);
    });
  });

  describe('summarizeCache', () => {
    it('aggregates server cache tokens and computes the hit rate', () => {
      const result = summarizeCache([
        cacheRequest('miss', 100, {
          cacheSource: 'api',
          cachedPromptTokens: 10,
          promptTokens: 100
        }),
        cacheRequest('hit', null, {
          cacheSource: 'api',
          cachedPromptTokens: 5,
          promptTokens: 50
        })
      ]);

      expect(result.server).toEqual({
        cachedPromptTokens: 15,
        promptTokens: 150,
        tokenHitRate: 0.1,
        requestsWithData: 2,
        source: 'api'
      });
      expect(result.cold.n).toBe(1);
      expect(result.warm.n).toBe(0);
    });

    it('returns empty statistics for the group with no requests', () => {
      const coldOnly = summarizeCache(groupedRequests([5, 6, 7], [], {}));
      const warmOnly = summarizeCache(groupedRequests([], [5, 6, 7], {}));
      const emptyStats = { n: 0, median: null, mean: null, min: null, max: null };

      expect(coldOnly.warm).toEqual(emptyStats);
      expect(coldOnly.ttftDeltaMs).toBeNull();
      expect(coldOnly.ttftRatio).toBeNull();
      expect(coldOnly.insufficientSamples).toBe(true);
      expect(warmOnly.cold).toEqual(emptyStats);
      expect(warmOnly.ttftDeltaMs).toBeNull();
      expect(warmOnly.ttftRatio).toBeNull();
      expect(warmOnly.insufficientSamples).toBe(true);
    });

    it.each([
      [1, true],
      [2, true],
      [3, false]
    ])('marks %i samples in each group as insufficient=%s', (sampleCount, insufficient) => {
      const values = Array.from({ length: sampleCount }, (_, index) => index + 1);
      const result = summarizeCache(groupedRequests(values, values));

      expect(result.cold.n).toBe(sampleCount);
      expect(result.warm.n).toBe(sampleCount);
      expect(result.insufficientSamples).toBe(insufficient);
    });

    it('excludes null TTFT from latency stats while retaining its server token data', () => {
      const requests = groupedRequests([100, 110, 120], [50, 55, 60]);
      requests.push(cacheRequest('miss', null, {
        cacheSource: 'api',
        cachedPromptTokens: 3,
        promptTokens: 30
      }));

      const result = summarizeCache(requests);

      expect(result.cold.n).toBe(3);
      expect(result.server.cachedPromptTokens).toBe(3);
      expect(result.server.promptTokens).toBe(30);
      expect(result.ttftDeltaMs).toBe(55);
    });

    it('returns a null ratio when the warm median is zero', () => {
      const result = summarizeCache(groupedRequests([5, 6, 7], [0, 0, 0]));

      expect(result.warm.median).toBe(0);
      expect(result.ttftDeltaMs).toBe(6);
      expect(result.ttftRatio).toBeNull();
    });

    it('returns null server statistics when no request reports API cache usage', () => {
      const result = summarizeCache(groupedRequests([100, 110, 120], [50, 55, 60]));

      expect(result.server).toBeNull();
      expect(result.verdict).toBe('benefit');
    });

    it('returns inconclusive when either group has fewer than three samples', () => {
      const result = summarizeCache(groupedRequests([100, 110], [50, 55, 60]));

      expect(result.insufficientSamples).toBe(true);
      expect(result.verdict).toBe('inconclusive');
    });

    it('returns no-benefit when the server reports zero token hit rate despite faster warm TTFT', () => {
      const requests = groupedRequests([100, 110, 120], [50, 55, 60], {
        cacheSource: 'api',
        cachedPromptTokens: 0,
        promptTokens: 100
      });
      const result = summarizeCache(requests);

      expect(result.server.tokenHitRate).toBe(0);
      expect(result.warm.median).toBeLessThan(result.cold.median);
      expect(result.verdict).toBe('no-benefit');
    });

    it('returns benefit for positive server hit rate and faster warm TTFT', () => {
      const result = summarizeCache(groupedRequests([100, 110, 120], [50, 55, 60], {
        cacheSource: 'api',
        cachedPromptTokens: 10,
        promptTokens: 100
      }));

      expect(result.server.tokenHitRate).toBe(0.1);
      expect(result.verdict).toBe('benefit');
    });

    it('returns inconclusive for positive server hit rate without faster warm TTFT', () => {
      const result = summarizeCache(groupedRequests([50, 55, 60], [100, 110, 120], {
        cacheSource: 'api',
        cachedPromptTokens: 10,
        promptTokens: 100
      }));

      expect(result.verdict).toBe('inconclusive');
    });

    it('returns no-benefit without server data when warm TTFT is not faster', () => {
      const result = summarizeCache(groupedRequests([50, 55, 60], [100, 110, 120]));

      expect(result.verdict).toBe('no-benefit');
    });

    it('counts each request once when any response-cache suspicion condition matches', () => {
      const result = summarizeCache([
        cacheRequest('miss', null, { outputTokens: 0, contentTokens: 4 }),
        cacheRequest('miss', null, { generationTime: 0, contentTokens: 5 }),
        cacheRequest('hit', null, { hasUsage: false, contentTokens: 6 }),
        cacheRequest('hit', null, {
          outputTokens: 0,
          generationTime: 0,
          hasUsage: false,
          contentTokens: 7
        }),
        cacheRequest('miss', null, { outputTokens: 0, contentTokens: 0 })
      ]);

      expect(result.responseCacheSuspected).toBe(4);
    });

    it('counts truncated successful requests and ignores failed requests', () => {
      const result = summarizeCache([
        cacheRequest('miss', 1, { outputTokens: 10, maxOutputTokens: 10 }),
        { success: false, outputTokens: 10, maxOutputTokens: 10 },
        cacheRequest('hit', 2, { outputTokens: 9, maxOutputTokens: 10 })
      ]);

      expect(result.truncatedRequests).toBe(1);
    });

    it('ignores failed requests for TTFT and server usage totals', () => {
      const result = summarizeCache([
        cacheRequest('miss', 100, {
          cacheSource: 'api',
          cachedPromptTokens: 5,
          promptTokens: 10
        }),
        {
          success: false,
          cacheIntent: 'miss',
          ttft: 1,
          cacheSource: 'api',
          cachedPromptTokens: 100,
          promptTokens: 100
        }
      ]);

      expect(result.cold.n).toBe(1);
      expect(result.server).toEqual({
        cachedPromptTokens: 5,
        promptTokens: 10,
        tokenHitRate: 0.5,
        requestsWithData: 1,
        source: 'api'
      });
    });
  });
});
