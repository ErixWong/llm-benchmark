import { describe, expect, it } from 'vitest';
import { computeDecodeStats, mergeIntervals } from '../src/decode-stats.js';

describe('mergeIntervals', () => {
  it('merges unordered, overlapping, and touching intervals', () => {
    expect(mergeIntervals([
      [8, 12],
      [0, 4],
      [3, 7],
      [7, 8],
      [20, 22]
    ])).toEqual([[0, 12], [20, 22]]);
  });

  it('preserves isolated zero-length intervals and handles empty input', () => {
    expect(mergeIntervals([[4, 4], [0, 0], [0, 2], [2, 2]])).toEqual([
      [0, 2],
      [4, 4]
    ]);
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('computeDecodeStats', () => {
  it('returns null indicators when there are no successful requests', () => {
    expect(computeDecodeStats([], 1000)).toEqual({
      decodeWindowMs: 0,
      decodeDurationMs: 0,
      decodeThroughputTps: null,
      effectiveDecodeConcurrency: null
    });
    expect(computeDecodeStats([{ success: false, generationTime: 1000 }], 1000)).toMatchObject({
      decodeThroughputTps: null,
      effectiveDecodeConcurrency: null
    });
  });

  it('ignores failed requests', () => {
    const stats = computeDecodeStats([
      { success: true, responseReceiveTime: 2000, generationTime: 1000, outputTokens: 100 },
      { success: false, responseReceiveTime: 2000, generationTime: 9000, outputTokens: 9000 }
    ], 2000);

    expect(stats).toEqual({
      decodeWindowMs: 1000,
      decodeDurationMs: 1000,
      decodeThroughputTps: 100,
      effectiveDecodeConcurrency: 0.5
    });
  });

  it.each([0, undefined])('returns null concurrency for invalid total time (%s)', (totalTimeMs) => {
    const stats = computeDecodeStats([
      { success: true, responseReceiveTime: 2000, generationTime: 1000, outputTokens: 100 }
    ], totalTimeMs);

    expect(stats.effectiveDecodeConcurrency).toBeNull();
  });

  it('keeps concurrency defined when all decode windows have zero length', () => {
    const stats = computeDecodeStats([
      { success: true, responseReceiveTime: 2000, generationTime: 0, outputTokens: 1 }
    ], 500);

    expect(stats.decodeWindowMs).toBe(0);
    expect(stats.decodeThroughputTps).toBeNull();
    expect(stats.effectiveDecodeConcurrency).toBe(0);
  });

  it('matches the single request TPS when concurrency is one', () => {
    const request = {
      success: true,
      responseReceiveTime: 3000,
      generationTime: 2000,
      outputTokens: 200,
      tps: 100
    };

    expect(computeDecodeStats([request], 2500).decodeThroughputTps)
      .toBeCloseTo(request.tps, 6);
  });

  it('counts fully overlapping windows once while summing request decode durations', () => {
    const requests = [
      { success: true, responseReceiveTime: 2000, generationTime: 1000, outputTokens: 100, tps: 100 },
      { success: true, responseReceiveTime: 2000, generationTime: 1000, outputTokens: 100, tps: 100 }
    ];
    const stats = computeDecodeStats(requests, 1000);

    expect(stats.decodeWindowMs).toBe(1000);
    expect(stats.decodeDurationMs).toBe(2000);
    expect(stats.effectiveDecodeConcurrency).toBeCloseTo(2, 6);
    expect(stats.decodeThroughputTps).toBeCloseTo(
      requests.reduce((sum, request) => sum + request.tps, 0),
      6
    );
  });

  it('decomposes wall-clock throughput into duration-weighted single-stream TPS and effective concurrency', () => {
    const requests = [
      { success: true, responseReceiveTime: 1000, generationTime: 1000, outputTokens: 100, tps: 100 },
      { success: true, responseReceiveTime: 2000, generationTime: 1000, outputTokens: 160, tps: 160 }
    ];
    const stats = computeDecodeStats(requests, 2000);
    const meanSingleStreamTps = requests.reduce((sum, request) => sum + request.tps, 0) / requests.length;
    const throughputTps = requests.reduce((sum, request) => sum + request.outputTokens, 0) / 2;

    expect(meanSingleStreamTps * stats.effectiveDecodeConcurrency).toBeCloseTo(throughputTps, 6);
  });
});
