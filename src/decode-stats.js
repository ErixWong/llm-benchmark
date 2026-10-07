/**
 * 解码期统计：把成功请求首 token 到末 token 的窗口用于聚合吞吐与并发度计算。
 */

/**
 * 合并重叠或相接的时间区间。
 * @param {Array<[number, number]>} intervals
 * @returns {Array<[number, number]>}
 */
export function mergeIntervals(intervals = []) {
  const sorted = intervals
    .filter((interval) => (
      Array.isArray(interval)
      && interval.length >= 2
      && Number.isFinite(interval[0])
      && Number.isFinite(interval[1])
      && interval[1] >= interval[0]
    ))
    .map(([start, end]) => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  if (sorted.length === 0) return [];

  const merged = [];
  let [start, end] = sorted[0];
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      merged.push([start, end]);
      [start, end] = [nextStart, nextEnd];
    }
  }
  merged.push([start, end]);
  return merged;
}

/**
 * 计算成功请求在解码期的聚合统计。
 * @param {Array<Object>} requests
 * @param {number} totalTimeMs - 整次测试的墙钟时长
 * @returns {{
 *   decodeWindowMs:number,
 *   decodeDurationMs:number,
 *   decodeThroughputTps:number|null,
 *   effectiveDecodeConcurrency:number|null
 * }}
 */
export function computeDecodeStats(requests = [], totalTimeMs) {
  const successfulRequests = Array.isArray(requests)
    ? requests.filter((request) => request?.success === true)
    : [];
  if (successfulRequests.length === 0) {
    return {
      decodeWindowMs: 0,
      decodeDurationMs: 0,
      decodeThroughputTps: null,
      effectiveDecodeConcurrency: null
    };
  }

  const intervals = [];
  let decodeDurationMs = 0;
  let totalOutputTokens = 0;

  for (const request of successfulRequests) {
    const generationTime = request.generationTime;
    if (Number.isFinite(generationTime) && generationTime >= 0) {
      decodeDurationMs += generationTime;
      if (Number.isFinite(request.responseReceiveTime)) {
        intervals.push([
          request.responseReceiveTime - generationTime,
          request.responseReceiveTime
        ]);
      }
    }
    if (Number.isFinite(request.outputTokens) && request.outputTokens >= 0) {
      totalOutputTokens += request.outputTokens;
    }
  }

  const decodeWindowMs = mergeIntervals(intervals)
    .reduce((duration, [start, end]) => duration + end - start, 0);
  const decodeThroughputTps = decodeWindowMs > 0
    ? totalOutputTokens / decodeWindowMs * 1000
    : null;
  const effectiveDecodeConcurrency = Number.isFinite(totalTimeMs) && totalTimeMs > 0
    ? decodeDurationMs / totalTimeMs
    : null;

  return {
    decodeWindowMs,
    decodeDurationMs,
    decodeThroughputTps,
    effectiveDecodeConcurrency
  };
}

export default {
  mergeIntervals,
  computeDecodeStats
};
