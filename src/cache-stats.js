const MIN_SAMPLES = 3;

/**
 * 提取服务端 usage 中的缓存 prompt token 数。
 *
 * @param {Object|null} apiUsage - 服务端 usage
 * @param {number|null|undefined} promptTokens - 本次请求的 prompt token 数
 * @returns {{cachedPromptTokens:number|null, source:'api'|'unknown'}}
 */
export function extractCacheUsage(apiUsage, promptTokens) {
  const candidates = [
    apiUsage?.prompt_tokens_details?.cached_tokens,
    apiUsage?.prompt_cache_hit_tokens,
    apiUsage?.cache_read_input_tokens,
    apiUsage?.usage_metadata?.cached_content_token_count
  ];

  for (const value of candidates) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !(value >= 0)) {
      return { cachedPromptTokens: null, source: 'unknown' };
    }
    if (typeof promptTokens === 'number' && !(value <= promptTokens)) {
      return { cachedPromptTokens: null, source: 'unknown' };
    }
    return { cachedPromptTokens: value, source: 'api' };
  }

  return { cachedPromptTokens: null, source: 'unknown' };
}

/**
 * 判断输出 token 数是否触及 max_tokens 上限。
 *
 * @param {Object} params
 * @param {number} params.outputTokens - 输出 token 数
 * @param {number} params.maxOutputTokens - 输出 token 上限
 * @returns {boolean}
 */
export function isTruncated({ outputTokens, maxOutputTokens } = {}) {
  return typeof outputTokens === 'number'
    && typeof maxOutputTokens === 'number'
    && outputTokens > 0
    && maxOutputTokens > 0
    && outputTokens === maxOutputTokens;
}

/**
 * 汇总缓存请求的冷/热 TTFT、服务端缓存命中率及诊断信息。
 *
 * @param {Array<Object>} requests - 逐请求结果
 * @returns {{cold:Object, warm:Object, ttftDeltaMs:number|null, ttftRatio:number|null,
 *            insufficientSamples:boolean, server:Object|null,
 *            verdict:'benefit'|'no-benefit'|'inconclusive',
 *            responseCacheSuspected:number, truncatedRequests:number}}
 */
export function summarizeCache(requests = []) {
  const successfulRequests = requests.filter((request) => request?.success !== false);
  const coldTtft = [];
  const warmTtft = [];

  for (const request of successfulRequests) {
    if (typeof request?.ttft !== 'number' || !Number.isFinite(request.ttft)) continue;
    if (request.cacheIntent === 'miss') coldTtft.push(request.ttft);
    if (request.cacheIntent === 'hit') warmTtft.push(request.ttft);
  }

  const summarize = (values) => {
    if (values.length === 0) {
      return { n: 0, median: null, mean: null, min: null, max: null };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];

    return {
      n: sorted.length,
      median,
      mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1]
    };
  };

  const cold = summarize(coldTtft);
  const warm = summarize(warmTtft);
  const ttftDeltaMs = cold.median !== null && warm.median !== null
    ? cold.median - warm.median
    : null;
  const ttftRatio = cold.median !== null && warm.median !== null && warm.median !== 0
    ? cold.median / warm.median
    : null;
  const insufficientSamples = cold.n < MIN_SAMPLES || warm.n < MIN_SAMPLES;

  const apiRequests = successfulRequests.filter((request) => request?.cacheSource === 'api');
  let server = null;
  if (apiRequests.length > 0) {
    const requestsWithData = apiRequests.filter((request) => (
      typeof request.cachedPromptTokens === 'number' && request.cachedPromptTokens >= 0
      && typeof request.promptTokens === 'number' && request.promptTokens >= 0
    ));
    const cachedPromptTokens = requestsWithData.reduce(
      (sum, request) => sum + request.cachedPromptTokens,
      0
    );
    const promptTokens = requestsWithData.reduce(
      (sum, request) => sum + request.promptTokens,
      0
    );

    server = {
      cachedPromptTokens,
      promptTokens,
      tokenHitRate: promptTokens > 0 ? cachedPromptTokens / promptTokens : null,
      requestsWithData: requestsWithData.length,
      source: 'api'
    };
  }

  let verdict;
  if (insufficientSamples) {
    verdict = 'inconclusive';
  } else if (server !== null && server.requestsWithData > 0) {
    if (server.tokenHitRate === 0) {
      verdict = 'no-benefit';
    } else if (server.tokenHitRate > 0 && warm.median < cold.median) {
      verdict = 'benefit';
    } else {
      verdict = 'inconclusive';
    }
  } else if (server === null) {
    verdict = warm.median < cold.median ? 'benefit' : 'no-benefit';
  } else {
    verdict = 'inconclusive';
  }

  const usageSeenInRun = successfulRequests.some((request) => request?.hasUsage === true);
  const responseCacheSuspected = successfulRequests.filter((request) => (
    typeof request?.contentTokens === 'number'
    && request.contentTokens > 0
    && (
      request.outputTokens === 0
      || request.generationTime === 0
      || (request.hasUsage === false && usageSeenInRun)
    )
  )).length;
  const truncatedRequests = successfulRequests.filter((request) => isTruncated(request)).length;

  return {
    cold,
    warm,
    ttftDeltaMs,
    ttftRatio,
    insufficientSamples,
    server,
    verdict,
    responseCacheSuspected,
    truncatedRequests
  };
}

export default {
  extractCacheUsage,
  isTruncated,
  summarizeCache
};
