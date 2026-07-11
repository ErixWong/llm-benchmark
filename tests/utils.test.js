import { describe, it, expect, vi } from 'vitest';
import { safeParseInt } from '../src/utils.js';

describe('safeParseInt', () => {
  describe('edge cases', () => {
    it('should return default value when input is undefined', () => {
      expect(safeParseInt(undefined, 90, 'timeout')).toBe(90);
    });

    it('should return default value when input is null', () => {
      expect(safeParseInt(null, 90, 'timeout')).toBe(90);
    });

    it('should return default value when input is empty string', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(safeParseInt('', 90, 'timeout')).toBe(90);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should return default value when input is not a number', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(safeParseInt('abc', 90, 'timeout')).toBe(90);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should not warn when quiet is true and input is invalid', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(safeParseInt('abc', 90, 'timeout', true)).toBe(90);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should return parsed value for valid number', () => {
      expect(safeParseInt('120', 90, 'timeout')).toBe(120);
    });

    it('should handle zero correctly (zero is a valid value)', () => {
      expect(safeParseInt('0', 90, 'timeout')).toBe(0);
    });

    it('should parse negative numbers', () => {
      expect(safeParseInt('-10', 90, 'timeout')).toBe(-10);
    });
  });

  describe('timeout boundary values', () => {
    it('should accept timeout value 1 (minimum)', () => {
      expect(safeParseInt('1', 90, 'timeout')).toBe(1);
    });

    it('should accept timeout value 3600 (maximum)', () => {
      expect(safeParseInt('3600', 90, 'timeout')).toBe(3600);
    });

    it('should accept timeout value 90 (default)', () => {
      expect(safeParseInt('90', 90, 'timeout')).toBe(90);
    });
  });
});
