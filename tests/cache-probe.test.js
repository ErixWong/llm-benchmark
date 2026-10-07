import { describe, expect, it } from 'vitest';
import { countTokens, hashText } from '../src/cache-source.js';
import {
  buildProbeUnits,
  checkUniquePrefixes,
  evaluateProbePreflight,
  makeRunSalt,
  verifyPrefix
} from '../src/cache-probe.js';

const materials = [
  { id: 'first', text: 'A stable cache prefix. '.repeat(8), tokens: 40 },
  { id: 'second', text: '另一段稳定的素材内容。'.repeat(8), tokens: 40 }
];
const suffix = '\n\n请用三点总结以上内容。';

describe('cache-probe', () => {
  describe('buildProbeUnits', () => {
    it('builds identical units for identical inputs', () => {
      const params = { materials, suffix, runSalt: 'abcd' };

      expect(buildProbeUnits(params)).toEqual(buildProbeUnits(params));
    });

    it('keeps cold and warm content paired with equal token counts', () => {
      const units = buildProbeUnits({ materials, suffix, runSalt: 'abcd' });

      for (const unit of units) {
        expect(unit.warm.startsWith(unit.warmNonce)).toBe(true);
        expect(unit.cold.startsWith(unit.coldNonce)).toBe(true);
        expect(unit.warm.slice(unit.warmNonce.length))
          .toBe(unit.cold.slice(unit.coldNonce.length));
        expect(countTokens(unit.warm)).toBe(countTokens(unit.cold));
      }
    });

    it('uses a fixed nonce width for each run and widens beyond three digits', () => {
      const indexedMaterials = Array.from({ length: 1001 }, (_, id) => ({
        id,
        text: `material ${id}`,
        tokens: 2
      }));
      const units = buildProbeUnits({
        materials: indexedMaterials,
        suffix: '\nrequest',
        runSalt: 'abcd'
      });

      expect(units[0].warmNonce).toMatch(/w0000\]$/);
      expect(units[10].warmNonce).toMatch(/w0010\]$/);
      expect(units[1000].warmNonce).toMatch(/w1000\]$/);
      expect(new Set(units.map((unit) => unit.warmNonce)).size).toBe(1001);
      expect(new Set(units.map((unit) => unit.coldNonce)).size).toBe(1001);
      expect(units.every((unit) => unit.warmNonce.length === units[0].warmNonce.length))
        .toBe(true);
      expect(units.every((unit) => unit.coldNonce.length === units[0].coldNonce.length))
        .toBe(true);
      expect(checkUniquePrefixes(units)).toEqual({ ok: true, duplicates: [] });
    });

    it('keeps three-digit nonces for a single unit', () => {
      const [unit] = buildProbeUnits({ materials: [materials[0]], runSalt: 'abcd' });

      expect(unit.warmNonce).toMatch(/w000\]$/);
      expect(unit.coldNonce).toMatch(/c000\]$/);
    });

    it('includes a hash and token count for the exact primed prefix', () => {
      const [unit] = buildProbeUnits({ materials: [materials[0]], runSalt: 'abcd' });

      expect(unit.prefixHash).toBe(hashText(unit.primed));
      expect(unit.prefixTokens).toBe(countTokens(unit.primed));
      expect(unit.itemId).toBe(materials[0].id);
    });

    it('handles omitted materials and non-string suffixes', () => {
      expect(buildProbeUnits({ runSalt: 'abcd' })).toEqual([]);
      expect(buildProbeUnits({ materials: [], runSalt: 'abcd' })).toEqual([]);
      expect(buildProbeUnits({
        materials: [materials[0]],
        suffix: undefined,
        runSalt: 'abcd'
      })[0].warm).toBe(buildProbeUnits({
        materials: [materials[0]],
        runSalt: 'abcd'
      })[0].warm);
      expect(buildProbeUnits({
        materials: [materials[0]],
        suffix: 42,
        runSalt: 'abcd'
      })[0].warm).toBe(buildProbeUnits({
        materials: [materials[0]],
        runSalt: 'abcd'
      })[0].warm);
    });
  });

  describe('checkUniquePrefixes', () => {
    it('accepts unique prefixes across units and categories', () => {
      const units = buildProbeUnits({ materials, suffix, runSalt: 'abcd' });

      expect(checkUniquePrefixes(units)).toEqual({ ok: true, duplicates: [] });
    });

    describe('evaluateProbePreflight', () => {
      it('passes unique units whose warm text starts with the primed prefix', () => {
        const units = buildProbeUnits({ materials, suffix, runSalt: 'abcd' });

        expect(evaluateProbePreflight(units)).toEqual({
          ok: true,
          unique: { ok: true, duplicates: [] },
          verified: 2,
          total: 2,
          errors: []
        });
      });

      it('fails duplicate nonce units and reports the preflight errors', () => {
        const [repeatedUnit] = buildProbeUnits({
          materials: [materials[0]],
          suffix,
          runSalt: 'abcd'
        });

        const result = evaluateProbePreflight([repeatedUnit, repeatedUnit]);

        expect(result.ok).toBe(false);
        expect(result.unique.ok).toBe(false);
        expect(result.verified).toBe(2);
        expect(result.total).toBe(2);
        expect(result.errors).toEqual(['前缀不唯一（重复项 3 个）']);
      });

      it('rejects an explicitly null unit list with a clear error', () => {
        expect(evaluateProbePreflight(null)).toEqual({
          ok: false,
          unique: { ok: true, duplicates: [] },
          verified: 0,
          total: 0,
          errors: ['没有可校验的缓存探针单元']
        });
      });

      it.each(['prefixHash', 'prefixTokens'])('rejects a tampered %s', (field) => {
        const [unit] = buildProbeUnits({ materials: [materials[0]], runSalt: 'abcd' });
        const tamperedUnit = {
          ...unit,
          [field]: field === 'prefixHash' ? 'tampered' : unit.prefixTokens + 1
        };

        const result = evaluateProbePreflight([tamperedUnit]);

        expect(result.ok).toBe(false);
        expect(result.errors).toContain(
          field === 'prefixHash'
            ? '预热前缀摘要校验失败 1/1'
            : '预热前缀 Token 数校验失败 1/1'
        );
      });
    });

    it('reports repeated prefixes once in stable encounter order', () => {
      const repeatedUnit = {
        primed: 'primed',
        warm: 'warm',
        cold: 'cold'
      };

      expect(checkUniquePrefixes([repeatedUnit, repeatedUnit])).toEqual({
        ok: false,
        duplicates: ['primed', 'warm', 'cold']
      });
    });

    it('limits duplicate details to the first ten unique strings', () => {
      const units = Array.from({ length: 11 }, (_, index) => ({
        primed: `primed-${index}`,
        warm: `warm-${index}`,
        cold: `cold-${index}`
      }));

      expect(checkUniquePrefixes([...units, ...units])).toEqual({
        ok: false,
        duplicates: [
          'primed-0', 'warm-0', 'cold-0',
          'primed-1', 'warm-1', 'cold-1',
          'primed-2', 'warm-2', 'cold-2',
          'primed-3'
        ]
      });
    });
  });

  describe('verifyPrefix', () => {
    it('accepts a warm request that starts with the primed prefix', () => {
      const [unit] = buildProbeUnits({ materials: [materials[0]], suffix, runSalt: 'abcd' });

      expect(verifyPrefix(unit.primed, unit.warm)).toEqual({ ok: true });
    });

    it('rejects changed material, non-string values, and an empty prefix', () => {
      const [unit] = buildProbeUnits({ materials: [materials[0]], suffix, runSalt: 'abcd' });
      const changedWarm = unit.warm.slice(0, unit.warmNonce.length)
        + 'X'
        + unit.warm.slice(unit.warmNonce.length + 1);

      expect(verifyPrefix(unit.primed, changedWarm)).toEqual({
        ok: false,
        reason: '热请求文本不是以预热前缀开头'
      });
      expect(verifyPrefix(null, unit.warm)).toEqual({
        ok: false,
        reason: '预热前缀和热请求文本都必须是字符串'
      });
      expect(verifyPrefix('', '')).toEqual({
        ok: false,
        reason: '预热前缀不能为空'
      });
    });
  });

  describe('makeRunSalt', () => {
    it('returns four characters from the unambiguous alphabet', () => {
      const safeCharacters = '23456789abcdefghjkmnpqrstuvwxyz';
      const salts = Array.from({ length: 20 }, () => makeRunSalt());

      for (const salt of salts) {
        expect(salt).toHaveLength(4);
        expect([...salt].every((character) => safeCharacters.includes(character))).toBe(true);
      }
      expect(new Set(salts).size).toBe(salts.length);
    });
  });
});
