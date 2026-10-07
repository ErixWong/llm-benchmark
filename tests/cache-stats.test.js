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
  ...coldTtft.map((ttft, index) => cacheRequest('miss', ttft, {
    requestIndex: index * 2,
    ...fields
  })),
  ...warmTtft.map((ttft, index) => cacheRequest('hit', ttft, {
    requestIndex: index * 2 + 1,
    ...fields
  }))
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

    it('uses the same complete-data requests for both token totals and preserves paired evidence', () => {
      const requests = groupedRequests([100, 110, 120], [50, 55, 60]);
      requests.push(
        cacheRequest('miss', null, {
          cacheSource: 'api',
          cachedPromptTokens: 200,
          promptTokens: null
        }),
        cacheRequest('hit', null, {
          cacheSource: 'api',
          cachedPromptTokens: 10,
          promptTokens: 100
        })
      );

      const result = summarizeCache(requests);
      const incompleteOnlyResult = summarizeCache([
        ...groupedRequests([100, 110, 120], [50, 55, 60]),
        cacheRequest('miss', null, {
          cacheSource: 'api',
          cachedPromptTokens: 200,
          promptTokens: null
        })
      ]);

      expect(result.server.tokenHitRate).toBeLessThanOrEqual(1);
      expect(result.server.requestsWithData).toBe(1);
      expect(result.server.cachedPromptTokens).toBe(10);
      expect(result.server.promptTokens).toBe(100);
      expect(result.verdict).toBe('benefit');
      expect(result.reason).toBe('consistent-benefit');

      expect(incompleteOnlyResult.server).toEqual({
        cachedPromptTokens: 0,
        promptTokens: 0,
        tokenHitRate: null,
        requestsWithData: 0,
        source: 'api'
      });
      expect(incompleteOnlyResult.verdict).toBe('benefit');
      expect(incompleteOnlyResult.reason).toBe('consistent-benefit');
    });

    it('returns empty statistics for the group with no requests', () => {
      const coldOnly = summarizeCache(groupedRequests([5, 6, 7], [], {}));
      const warmOnly = summarizeCache(groupedRequests([], [5, 6, 7], {}));
      const emptyStats = { n: 0, median: null, mean: null, min: null, max: null };

      expect(coldOnly.warm).toEqual(emptyStats);
      expect(coldOnly.ttftDeltaMs).toBeNull();
      expect(coldOnly.ttftRatio).toBeNull();
      expect(coldOnly.insufficientSamples).toBe(true);
      expect(coldOnly.pairDeltas).toEqual([]);
      expect(coldOnly.pairsTotal).toBe(0);
      expect(warmOnly.cold).toEqual(emptyStats);
      expect(warmOnly.ttftDeltaMs).toBeNull();
      expect(warmOnly.ttftRatio).toBeNull();
      expect(warmOnly.insufficientSamples).toBe(true);
      expect(warmOnly.pairDeltas).toEqual([]);
      expect(warmOnly.pairsTotal).toBe(0);
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
      expect(result.reason).toBe('insufficient-samples');
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
      expect(result.reason).toBe('server-reports-zero');
    });

    it('returns benefit for positive server hit rate and faster warm TTFT', () => {
      const result = summarizeCache(groupedRequests([100, 110, 120], [50, 55, 60], {
        cacheSource: 'api',
        cachedPromptTokens: 10,
        promptTokens: 100
      }));

      expect(result.server.tokenHitRate).toBe(0.1);
      expect(result.verdict).toBe('benefit');
      expect(result.reason).toBe('consistent-benefit');
    });

    it('returns inconclusive for positive server hit rate without faster warm TTFT', () => {
      const result = summarizeCache(groupedRequests([50, 55, 60], [100, 110, 120], {
        cacheSource: 'api',
        cachedPromptTokens: 10,
        promptTokens: 100
      }));

      expect(result.verdict).toBe('inconclusive');
      expect(result.reason).toBe('inconsistent-pair-deltas');
    });

    it('returns no-benefit without server data when warm TTFT is not faster', () => {
      const result = summarizeCache(groupedRequests([50, 55, 60], [100, 110, 120]));

      expect(result.verdict).toBe('no-benefit');
      expect(result.reason).toBe('no-consistent-benefit');
    });

    it('does not infer benefit from group medians when paired deltas are inconsistent', () => {
      const result = summarizeCache(groupedRequests(
        [772, 1686, 2202],
        [760, 986, 2707]
      ));

      expect(result.cold.median - result.warm.median).toBe(700);
      expect(result.pairDeltas).toEqual([-12, -700, 505]);
      expect(result.pairsFavorable).toBe(2);
      expect(result.pairsUnfavorable).toBe(1);
      expect(result.pairedMedianDeltaMs).toBe(-12);
      expect(result.verdict).toBe('no-benefit');
      expect(result.reason).toBe('no-consistent-benefit');
    });

    it('returns benefit when every paired delta is negative', () => {
      const result = summarizeCache(groupedRequests([100, 110, 120], [90, 100, 110]));

      expect(result.pairDeltas).toEqual([-10, -10, -10]);
      expect(result.pairsFavorable).toBe(3);
      expect(result.pairsUnfavorable).toBe(0);
      expect(result.reason).toBe('consistent-benefit');
      expect(result.verdict).toBe('benefit');
    });

    it('sorts each intent group by requestIndex before pairing', () => {
      const result = summarizeCache([
        cacheRequest('hit', 60, { requestIndex: 5 }),
        cacheRequest('miss', 300, { requestIndex: 4 }),
        cacheRequest('hit', 20, { requestIndex: 1 }),
        cacheRequest('miss', 100, { requestIndex: 0 }),
        cacheRequest('miss', 200, { requestIndex: 2 }),
        cacheRequest('hit', 40, { requestIndex: 3 })
      ]);

      expect(result.pairDeltas).toEqual([-80, -160, -240]);
    });

    it('is inconclusive when fewer than three pairs have valid TTFT despite sufficient group samples', () => {
      const result = summarizeCache(groupedRequests(
        [null, null, 120, 130, 140],
        [90, 100, 110]
      ));

      expect(result.cold.n).toBe(3);
      expect(result.warm.n).toBe(3);
      expect(result.pairsTotal).toBe(1);
      expect(result.insufficientSamples).toBe(true);
      expect(result.verdict).toBe('inconclusive');
      expect(result.reason).toBe('insufficient-samples');
    });

    it('skips a pair when either request has a non-finite TTFT without shifting later pairs', () => {
      const result = summarizeCache(groupedRequests(
        [100, null, 120, 130],
        [90, 80, 110, 120]
      ));

      expect(result.pairDeltas).toEqual([-10, -10, -10]);
      expect(result.pairsTotal).toBe(3);
    });

    it('uses server zero-hit evidence before otherwise consistent paired benefit', () => {
      const result = summarizeCache(groupedRequests(
        [100, 110, 120],
        [90, 100, 110],
        { cacheSource: 'api', cachedPromptTokens: 0, promptTokens: 100 }
      ));

      expect(result.pairsUnfavorable).toBe(0);
      expect(result.server.tokenHitRate).toBe(0);
      expect(result.verdict).toBe('no-benefit');
      expect(result.reason).toBe('server-reports-zero');
    });

    it('is inconclusive when the server reports hits but paired deltas are inconsistent', () => {
      const result = summarizeCache(groupedRequests(
        [100, 110, 120],
        [90, 100, 130],
        { cacheSource: 'api', cachedPromptTokens: 10, promptTokens: 100 }
      ));

      expect(result.pairDeltas).toEqual([-10, -10, 10]);
      expect(result.pairsUnfavorable).toBe(1);
      expect(result.verdict).toBe('inconclusive');
      expect(result.reason).toBe('inconsistent-pair-deltas');
    });

    it('does not suspect response cache when the run consistently omits usage', () => {
      const result = summarizeCache([
        cacheRequest('miss', null, {
          hasUsage: false,
          outputTokens: 4,
          generationTime: 10,
          contentTokens: 4
        }),
        cacheRequest('hit', null, {
          hasUsage: false,
          outputTokens: 5,
          generationTime: 12,
          contentTokens: 5
        })
      ]);

      expect(result.responseCacheSuspected).toBe(0);
    });

    it('suspects a request that omits usage when other requests in the run report usage', () => {
      const result = summarizeCache([
        cacheRequest('miss', null, { hasUsage: true, contentTokens: 4 }),
        cacheRequest('miss', null, { hasUsage: true, contentTokens: 5 }),
        cacheRequest('hit', null, { hasUsage: true, contentTokens: 6 }),
        cacheRequest('hit', null, {
          hasUsage: false,
          outputTokens: 5,
          generationTime: 12,
          contentTokens: 7
        })
      ]);

      expect(result.responseCacheSuspected).toBe(1);
    });

    it('does not suspect response cache when every request omits the hasUsage field', () => {
      const result = summarizeCache([
        cacheRequest('miss', null, { contentTokens: 4 }),
        cacheRequest('hit', null, { contentTokens: 5 })
      ]);

      expect(result.responseCacheSuspected).toBe(0);
    });

    it('counts output-token and generation-time suspicion conditions', () => {
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

      expect(result.responseCacheSuspected).toBe(3);
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
