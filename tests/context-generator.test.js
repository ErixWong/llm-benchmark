import { describe, it, expect } from 'vitest';
import { countTokens as tokenizerCountTokens } from 'gpt-tokenizer';
import { countTokens as chatTokenizerCountTokens } from 'gpt-tokenizer/model/gpt-3.5-turbo';
import { generateExactTokenText, countMessagesTokens, countTextTokens, validateContext } from '../src/context-generator.js';

describe('context-generator', () => {
  describe('generateExactTokenText', () => {
    it('should return empty string for targetTokens <= 0', () => {
      expect(generateExactTokenText(0)).toBe('');
      expect(generateExactTokenText(-1)).toBe('');
    });

    it('should generate text with correct token count (allow ±15% error)', () => {
      const target = 100;
      const result = generateExactTokenText(target);
      const actualTokens = countMessagesTokens([{ role: 'user', content: result }]);
      const errorMargin = Math.ceil(target * 0.15);
      expect(actualTokens).toBeGreaterThanOrEqual(target - errorMargin);
      expect(actualTokens).toBeLessThanOrEqual(target + errorMargin);
    });

    it('should handle small token counts with wider tolerance', () => {
      const target = 10;
      const result = generateExactTokenText(target);
      const actualTokens = countMessagesTokens([{ role: 'user', content: result }]);
      expect(actualTokens).toBeGreaterThanOrEqual(5);
      expect(actualTokens).toBeLessThanOrEqual(25);
    });

    it('should handle large token counts', () => {
      const result = generateExactTokenText(5000);
      const actualTokens = countMessagesTokens([{ role: 'user', content: result }]);
      expect(actualTokens).toBeGreaterThanOrEqual(4500);
      expect(actualTokens).toBeLessThanOrEqual(5500);
    });
  });

  describe('countMessagesTokens', () => {
    it('should count tokens for single message', () => {
      const tokens = countMessagesTokens([{ role: 'user', content: 'Hello world' }]);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should count tokens for multiple messages', () => {
      const tokens = countMessagesTokens([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' }
      ]);
      expect(tokens).toBeGreaterThan(countMessagesTokens([{ role: 'user', content: 'Hello' }]));
    });

    it('should match tokenizer chat counting', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello world' }
      ];

      expect(countMessagesTokens(messages)).toBe(chatTokenizerCountTokens(messages));
    });
  });

  describe('countTextTokens', () => {
    it('should count plain text tokens', () => {
      const text = 'hello world';
      expect(countTextTokens(text)).toBe(tokenizerCountTokens(text));
    });

    it('should return zero for empty text', () => {
      expect(countTextTokens('')).toBe(0);
      expect(countTextTokens(null)).toBe(0);
    });
  });

  describe('validateContext', () => {
    it('should validate context correctly', () => {
      const messages = [{ role: 'user', content: 'Test message' }];
      const actualTokens = countMessagesTokens(messages);
      const result = validateContext(messages, actualTokens);
      
      expect(result.valid).toBe(true);
      expect(result.actualTokens).toBe(actualTokens);
      expect(result.expectedTokens).toBe(actualTokens);
    });

    it('should allow small difference (within 2 tokens)', () => {
      const messages = [{ role: 'user', content: 'Test' }];
      const actualTokens = countMessagesTokens(messages);
      const result = validateContext(messages, actualTokens);
      expect(result.valid).toBe(true);
    });
  });
});
