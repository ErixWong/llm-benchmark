import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpClient, normalizeApiUrl, validateParams, tokenSpeedTestRules } from '../src/http-client.js';
import { normalizeConcurrencyMode } from '../src/cli-options.js';

describe('http-client', () => {
  describe('normalizeApiUrl', () => {
    it('should add /v1/chat/completions for base URL', () => {
      expect(normalizeApiUrl('https://api.example.com')).toBe('https://api.example.com/v1/chat/completions');
    });

    it('should not modify URL ending with /chat/completions', () => {
      expect(normalizeApiUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions');
    });

    it('should add /chat/completions for URL ending with /v1', () => {
      expect(normalizeApiUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
    });

    it('should handle URLs with trailing slashes', () => {
      expect(normalizeApiUrl('https://api.example.com/')).toBe('https://api.example.com/v1/chat/completions');
    });

    it('should return empty string for empty input', () => {
      expect(normalizeApiUrl('')).toBe('');
      expect(normalizeApiUrl(null)).toBe(null);
      expect(normalizeApiUrl(undefined)).toBe(undefined);
    });
  });

  describe('validateParams', () => {
    it('should validate required parameters', () => {
      const result = validateParams({}, tokenSpeedTestRules);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('url is required');
    });

    it('should validate URL format', () => {
      const result = validateParams({ url: 'not-a-url' }, tokenSpeedTestRules);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('valid URL'))).toBe(true);
    });

    it('should validate numeric ranges', () => {
      const result = validateParams({ 
        url: 'https://api.example.com', 
        concurrency: 0 
      }, tokenSpeedTestRules);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('concurrency'))).toBe(true);
    });

    it('should pass for valid params', () => {
      const result = validateParams({ 
        url: 'https://api.example.com', 
        concurrency: 4,
        samples: 10
      }, tokenSpeedTestRules);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('normalizeConcurrencyMode', () => {
    it('should accept supported modes', () => {
      expect(normalizeConcurrencyMode('batch')).toBe('batch');
      expect(normalizeConcurrencyMode('pipeline')).toBe('pipeline');
    });

    it('should reject unsupported modes', () => {
      expect(() => normalizeConcurrencyMode('parallel')).toThrow(/batch 或 pipeline/);
    });
  });

  describe('quiet mode', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('should not log URL normalization when quiet=true', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      createHttpClient({
        baseURL: 'https://api.example.com',
        quiet: true
      });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('should not log retry messages when quiet=true', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const client = createHttpClient({
        baseURL: 'https://api.example.com/v1/chat/completions',
        quiet: true,
        retryConfig: {
          maxRetries: 1,
          retryDelay: 0,
          retryMultiplier: 1
        }
      });

      client.defaults.adapter = async (config) => {
        const error = new Error('rate limited');
        error.config = config;
        error.response = {
          status: 429,
          headers: {}
        };
        throw error;
      };

      await expect(client.post('/')).rejects.toThrow('rate limited');
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
