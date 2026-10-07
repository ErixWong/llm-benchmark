import { describe, expect, it } from 'vitest';
import { buildRequestPlan, selectDocuments } from '../src/cache-plan.js';

describe('cache-plan', () => {
  describe('selectDocuments', () => {
    it('rotates the starting file by unit while preserving ring order', () => {
      const files = ['a.txt', 'b.txt', 'c.txt'];

      expect(selectDocuments(files, 0, 0)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      expect(selectDocuments(files, 1, 0)).toEqual(['b.txt', 'c.txt', 'a.txt']);
      expect(selectDocuments(files, 2, 0)).toEqual(['c.txt', 'a.txt', 'b.txt']);
    });

    it('is reproducible for identical inputs', () => {
      const files = ['a.txt', 'b.txt', 'c.txt'];

      expect(selectDocuments(files, 4, 7)).toEqual(selectDocuments(files, 4, 7));
    });

    it('returns an empty list for empty input', () => {
      expect(selectDocuments([], 4, 7)).toEqual([]);
    });

    it('wraps an out-of-range seed offset modulo the file count', () => {
      const files = ['a.txt', 'b.txt', 'c.txt'];

      expect(selectDocuments(files, 1, 8)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    });
  });

  describe('buildRequestPlan', () => {
    it('puts cold before warm and maps intents correctly for each unit', () => {
      const plan = buildRequestPlan([
        { cold: 'cold-1', warm: 'warm-1' },
        { cold: 'cold-2', warm: 'warm-2' }
      ]);

      expect(plan).toEqual([
        { text: 'cold-1', intent: 'miss' },
        { text: 'warm-1', intent: 'hit' },
        { text: 'cold-2', intent: 'miss' },
        { text: 'warm-2', intent: 'hit' }
      ]);
      expect(plan).toHaveLength(2 * 2);
    });

    it('returns an empty list for no units', () => {
      expect(buildRequestPlan([])).toEqual([]);
    });
  });
});
