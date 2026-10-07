import { describe, expect, it } from 'vitest';
import {
  buildMaterial,
  chunkByHeadings,
  countTokens,
  hashMaterialBank,
  hashText
} from '../src/cache-source.js';

describe('cache-source', () => {
  it('builds identical material and evidence for identical inputs', () => {
    const params = {
      documents: [
        { name: 'first.md', text: `## Stable prefix\n${'The cache should see the exact same prefix. '.repeat(50)}` },
        { name: 'second.md', text: `### Follow-up\n${'Additional source text follows. '.repeat(40)}` }
      ],
      targetTokens: 120
    };

    expect(buildMaterial(params)).toEqual(buildMaterial(params));
  });

  describe('hashText', () => {
    it('returns stable 12-character SHA-256 prefixes', () => {
      expect(hashText('abc')).toBe('ba7816bf8f01');
      expect(hashText('')).toBe('e3b0c44298fc');
      expect(hashText('abc')).not.toBe(hashText('abd'));
    });
  });

  describe('hashMaterialBank', () => {
    it('is stable for identical material text and changes when any text changes', () => {
      const materials = [
        { text: 'first source text' },
        { text: 'second source text' }
      ];

      expect(hashMaterialBank(materials)).toBe(hashMaterialBank(materials));
      expect(hashMaterialBank(materials)).not.toBe(hashMaterialBank([
        materials[0],
        { text: 'second source texT' }
      ]));
    });
  });

  describe('chunkByHeadings', () => {
    it('splits at level-two and level-three headings and preserves all text', () => {
      const source = 'Preface\nMore preface\n## First\nBody\n### Nested\nNested body\n## Last\nEnd';
      const chunks = chunkByHeadings(source);

      expect(chunks).toEqual([
        { heading: '', text: 'Preface\nMore preface\n' },
        { heading: '## First', text: '## First\nBody\n' },
        { heading: '### Nested', text: '### Nested\nNested body\n' },
        { heading: '## Last', text: '## Last\nEnd' }
      ]);
      expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
    });

    it('returns a single block for plain text and no blocks for empty text', () => {
      expect(chunkByHeadings('Plain text\nwithout headings')).toEqual([
        { heading: '', text: 'Plain text\nwithout headings' }
      ]);
      expect(chunkByHeadings('')).toEqual([]);
    });
  });

  describe('buildMaterial', () => {
    it('fills close to the target without exceeding it', () => {
      const result = buildMaterial({
        documents: [
          { name: 'long.md', text: `## Long section\n${'The cache source must preserve a stable prefix across repeated tests. '.repeat(500)}` }
        ],
        targetTokens: 500
      });

      expect(result.tokens).toBeLessThanOrEqual(500);
      expect(result.tokens).toBeGreaterThanOrEqual(400);
      expect(result.tokens).toBe(countTokens(result.text));
      expect(result.hash).toBe(hashText(result.text));
    });

    it('truncates a single oversized block to the target', () => {
      const result = buildMaterial({
        documents: [{ name: 'large.md', text: `## Large\n${'A deterministic cache prefix. '.repeat(100)}` }],
        targetTokens: 12
      });

      expect(result.tokens).toBeLessThanOrEqual(12);
      expect(result.tokens).toBeGreaterThan(0);
    });

    it('appends later documents in caller-provided order', () => {
      const first = `First document marker. ${'first content. '.repeat(3)}`;
      const second = `Second document marker. ${'second content. '.repeat(100)}`;
      const forward = buildMaterial({
        documents: [
          { name: 'one.md', text: first },
          { name: 'two.md', text: second }
        ],
        targetTokens: 80
      });
      const reverse = buildMaterial({
        documents: [
          { name: 'two.md', text: second },
          { name: 'one.md', text: first }
        ],
        targetTokens: 80
      });

      expect(forward.text).toContain(first);
      expect(forward.text.indexOf(second.slice(0, 12))).toBeGreaterThan(forward.text.indexOf(first));
      expect(reverse.text).not.toBe(forward.text);
      expect(forward.tokens).toBeLessThanOrEqual(80);
    });

    it('does not introduce replacement characters when truncating Unicode', () => {
      const result = buildMaterial({
        documents: [{ name: 'unicode.md', text: `## 中文与 emoji\n${'缓存前缀🙂稳定复现。'.repeat(100)}` }],
        targetTokens: 20
      });

      expect(result.tokens).toBeLessThanOrEqual(20);
      expect(result.text).not.toContain('\uFFFD');
    });

    it('handles no documents and a zero-token target', () => {
      expect(() => buildMaterial({ documents: [], targetTokens: 0 })).not.toThrow();
      expect(buildMaterial({ documents: [], targetTokens: 0 })).toEqual({
        text: '',
        tokens: 0,
        hash: hashText('')
      });
    });
  });
});
