import { describe, it, expect } from 'vitest';
import { parseExtraBody, sanitizeExtraBody, RESERVED_BODY_KEYS } from '../src/extra-body.js';

describe('extra-body', () => {
  describe('parseExtraBody', () => {
    it('returns null for empty input', () => {
      expect(parseExtraBody('')).toBeNull();
      expect(parseExtraBody(undefined)).toBeNull();
      expect(parseExtraBody(null)).toBeNull();
    });

    it('parses a JSON object', () => {
      expect(parseExtraBody('{"chat_template_kwargs":{"enable_thinking":false}}')).toEqual({
        chat_template_kwargs: { enable_thinking: false }
      });
    });

    it('throws on invalid JSON', () => {
      expect(() => parseExtraBody('{oops}')).toThrow(/不是合法的 JSON/);
    });

    it('rejects non-object JSON', () => {
      expect(() => parseExtraBody('[1,2]')).toThrow(/JSON 对象/);
      expect(() => parseExtraBody('5')).toThrow(/JSON 对象/);
      expect(() => parseExtraBody('null')).toThrow(/JSON 对象/);
      expect(() => parseExtraBody('"str"')).toThrow(/JSON 对象/);
    });
  });

  describe('sanitizeExtraBody', () => {
    it('returns an empty body for invalid input', () => {
      expect(sanitizeExtraBody(null)).toEqual({ body: {}, dropped: [] });
      expect(sanitizeExtraBody([1])).toEqual({ body: {}, dropped: [] });
      expect(sanitizeExtraBody('x')).toEqual({ body: {}, dropped: [] });
    });

    it('drops reserved keys and reports them', () => {
      const { body, dropped } = sanitizeExtraBody({
        stream: false,
        model: 'x',
        messages: [],
        max_tokens: 1,
        top_p: 0.9
      });

      expect(body).toEqual({ top_p: 0.9 });
      expect([...dropped].sort()).toEqual([...RESERVED_BODY_KEYS].sort());
    });

    it('keeps stream_options so the caller can merge it', () => {
      const { body, dropped } = sanitizeExtraBody({ stream_options: { continuous_usage_stats: true } });
      expect(body.stream_options).toEqual({ continuous_usage_stats: true });
      expect(dropped).toEqual([]);
    });
  });
});
