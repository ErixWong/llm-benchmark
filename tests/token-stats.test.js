import { describe, it, expect } from 'vitest';
import { computeTokenStats, countTextTokens, getUsageReasoningTokens } from '../src/token-stats.js';

describe('token-stats', () => {
  describe('countTextTokens', () => {
    it('returns 0 for empty input', () => {
      expect(countTextTokens('')).toBe(0);
      expect(countTextTokens(null)).toBe(0);
      expect(countTextTokens(undefined)).toBe(0);
    });

    it('counts tokens without chat template overhead', () => {
      const text = 'Hello world';
      expect(countTextTokens(text)).toBeGreaterThan(0);
      // 与 encode 结果一致，且不含额外的 message 开销
      expect(countTextTokens(text)).toBeLessThan(countTextTokens('') + 10);
    });
  });

  describe('getUsageReasoningTokens', () => {
    it('reads completion_tokens_details.reasoning_tokens', () => {
      expect(getUsageReasoningTokens({ completion_tokens_details: { reasoning_tokens: 42 } })).toBe(42);
    });

    it('returns null when absent or non-numeric', () => {
      expect(getUsageReasoningTokens(null)).toBeNull();
      expect(getUsageReasoningTokens({})).toBeNull();
      expect(getUsageReasoningTokens({ completion_tokens_details: {} })).toBeNull();
      expect(getUsageReasoningTokens({ completion_tokens_details: { reasoning_tokens: '42' } })).toBeNull();
    });
  });

  describe('computeTokenStats', () => {
    it('uses server usage and subtracts same-source reasoning', () => {
      const result = computeTokenStats({
        outputText: 'ignored',
        reasoningText: 'ignored',
        apiUsage: { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } }
      });

      expect(result).toEqual({
        outputTokens: 100,
        contentTokens: 40,
        reasoningTokens: 60,
        tokenSource: 'api',
        reasoningTokenSource: 'api'
      });
    });

    it('clamps content to 0 when usage is inconsistent', () => {
      const result = computeTokenStats({
        apiUsage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 25 } }
      });

      expect(result.outputTokens).toBe(10);
      expect(result.contentTokens).toBe(0);
    });

    it('falls back to client tokenizer and never subtracts across sources', () => {
      const result = computeTokenStats({
        outputText: 'Hello world',
        reasoningText: 'thinking about it',
        apiUsage: null
      });

      expect(result.tokenSource).toBe('tokenizer');
      expect(result.reasoningTokenSource).toBe('tokenizer');
      expect(result.reasoningTokens).toBe(countTextTokens('thinking about it'));
      expect(result.contentTokens).toBe(countTextTokens('Hello world'));
      expect(result.outputTokens).toBe(result.contentTokens + result.reasoningTokens);
    });

    it('marks reasoning as client estimate when usage lacks reasoning detail', () => {
      const result = computeTokenStats({
        outputText: 'answer',
        reasoningText: 'think',
        apiUsage: { completion_tokens: 50 }
      });

      expect(result.outputTokens).toBe(50);
      expect(result.tokenSource).toBe('api');
      expect(result.reasoningTokenSource).toBe('tokenizer');
      expect(result.reasoningTokens).toBe(countTextTokens('think'));
      // content 独立计数，而不是 50 - 客户端推理数
      expect(result.contentTokens).toBe(countTextTokens('answer'));
    });

    it('handles an empty response', () => {
      expect(computeTokenStats({})).toEqual({
        outputTokens: 0,
        contentTokens: 0,
        reasoningTokens: 0,
        tokenSource: 'tokenizer',
        reasoningTokenSource: 'tokenizer'
      });
    });
  });
});
