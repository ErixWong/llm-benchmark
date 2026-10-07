import { describe, expect, it } from 'vitest';
import { selectSampleFiles } from '../src/sample-select.js';

describe('selectSampleFiles', () => {
  it('repeats the same selection for identical inputs', () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];

    expect(selectSampleFiles(files, 2, 3, 42)).toEqual(
      selectSampleFiles(files, 2, 3, 42)
    );
  });

  it('advances by the sample count and distributes selections evenly over a full cycle', () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt'];
    const sampleCount = 3;
    const cycleLength = files.length;
    const selections = Array.from(
      { length: cycleLength },
      (_, requestIndex) => selectSampleFiles(files, sampleCount, requestIndex, 0)
    );
    const counts = new Map(files.map(file => [file, 0]));

    expect(selections.slice(0, 4).map(selection => selection[0])).toEqual([
      'a.txt', 'd.txt', 'g.txt', 'c.txt'
    ]);
    for (const selection of selections) {
      expect(new Set(selection).size).toBe(selection.length);
      for (const file of selection) {
        counts.set(file, counts.get(file) + 1);
      }
    }

    const selectedCounts = [...counts.values()];
    expect(Math.max(...selectedCounts) - Math.min(...selectedCounts)).toBeLessThanOrEqual(1);
  });

  it('changes the starting point when the seed changes', () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];

    expect(selectSampleFiles(files, 2, 0, 42)[0]).not.toBe(
      selectSampleFiles(files, 2, 0, 43)[0]
    );
  });

  it('returns all unique files in stable sorted order when the count covers the list', () => {
    expect(selectSampleFiles(['c.txt', 'a.txt', 'b.txt', 'a.txt'], 4, 8, 3)).toEqual([
      'a.txt', 'b.txt', 'c.txt'
    ]);
  });

  it('returns an empty list for empty input or a non-positive sample count', () => {
    expect(selectSampleFiles([], 2, 0, 42)).toEqual([]);
    expect(selectSampleFiles(['a.txt'], 0, 0, 42)).toEqual([]);
    expect(selectSampleFiles(['a.txt'], -1, 0, 42)).toEqual([]);
  });
});
