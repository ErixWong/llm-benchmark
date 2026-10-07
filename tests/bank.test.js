import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hashBank,
  loadBank,
  selectBankItems,
  selectBankItemsByIds,
  validateBank
} from '../src/bank.js';

function makeBank() {
  return {
    name: 'test',
    version: 1,
    items: [
      { id: 'a1', prompt: 'prompt a1', expected: { contentTokens: 1, text: 'answer a1' }, tags: { genre: 'a', outputTier: 'a' } },
      { id: 'a2', prompt: 'prompt a2', expected: { contentTokens: 2, text: 'answer a2' }, tags: { genre: 'a', outputTier: 'a' } },
      { id: 'a3', prompt: 'prompt a3', expected: { contentTokens: 3, text: 'answer a3' }, tags: { genre: 'a', outputTier: 'a' } },
      { id: 'b1', prompt: 'prompt b1', expected: { contentTokens: 4, text: 'answer b1' }, tags: { genre: 'b', outputTier: 'b' } },
      { id: 'b2', prompt: 'prompt b2', expected: { contentTokens: 5, text: 'answer b2' }, tags: { genre: 'b', outputTier: 'b' } },
      { id: 'b3', prompt: 'prompt b3', expected: { contentTokens: 6, text: 'answer b3' }, tags: { genre: 'b', outputTier: 'b' } }
    ]
  };
}

describe('validateBank', () => {
  it('accepts a valid bank', () => {
    expect(validateBank(makeBank())).toEqual({ ok: true, errors: [] });
  });

  it('reports invalid top-level fields and item details', () => {
    const bank = makeBank();
    bank.name = ' ';
    bank.version = null;
    bank.items[1].id = bank.items[0].id;
    bank.items[1].prompt = ' ';
    bank.items[1].expected.contentTokens = -1;
    bank.items[1].expected.text = null;
    bank.items[1].tags.genre = '';

    const result = validateBank(bank);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('题库 name 必须是非空字符串');
    expect(result.errors).toContain('题库 version 必须是非空字符串或非负数字');
    expect(result.errors).toContain('条目 #2（id="a1"）的 id 重复');
    expect(result.errors).toContain('条目 #2（id="a1"）的 prompt 必须是非空字符串');
    expect(result.errors).toContain('条目 #2（id="a1"）的 expected.contentTokens 必须是非负整数');
    expect(result.errors).toContain('条目 #2（id="a1"）的 expected.text 必须是字符串');
    expect(result.errors).toContain('条目 #2（id="a1"）的 tags.genre 必须是非空字符串');
  });

  it('rejects non-object banks and missing item arrays', () => {
    expect(validateBank(null).ok).toBe(false);
    expect(validateBank({ name: 'empty', version: 1, items: [] }).errors).toContain(
      '题库 items 必须是非空数组'
    );
  });

  it('rejects IDs with leading or trailing whitespace', () => {
    const bank = makeBank();
    bank.items[0].id = ' item ';

    const result = validateBank(bank);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('条目 #1（id=" item "）的 id 不得包含首尾空白');
  });

  it('treats surrounding prompt whitespace as non-empty prompt content', () => {
    const bank = makeBank();
    bank.items[0].prompt = '  prompt a1  ';

    expect(validateBank(bank)).toEqual({ ok: true, errors: [] });
  });
});

describe('hashBank', () => {
  it('ignores recursive object key order but preserves array order', () => {
    const a = {
      name: 'x',
      version: 1,
      items: [{
        id: 'a',
        prompt: 'p',
        expected: { contentTokens: 1, text: 't' },
        tags: { genre: 'g' }
      }]
    };
    const b = {
      items: [{
        tags: { genre: 'g' },
        expected: { text: 't', contentTokens: 1 },
        prompt: 'p',
        id: 'a'
      }],
      version: 1,
      name: 'x'
    };
    const reorderedItems = makeBank();
    reorderedItems.items.reverse();

    expect(hashBank(a)).toBe(hashBank(b));
    expect(hashBank(makeBank())).not.toBe(hashBank(reorderedItems));
    expect(hashBank({ ...a, hash: 'derived-hash' })).toBe(hashBank(a));
  });
});

describe('loadBank', () => {
  it('loads, validates, and fingerprints a bank', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-bench-bank-'));
    try {
      const bankDir = path.join(root, 'data', 'banks');
      await fs.mkdir(bankDir, { recursive: true });
      const bank = makeBank();
      await fs.writeFile(path.join(bankDir, 'test.json'), JSON.stringify(bank));

      const loaded = await loadBank(root, 'test');
      expect(loaded).toEqual({ ...bank, hash: hashBank(bank) });
      expect(loaded.hash).toMatch(/^[a-f0-9]{12}$/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('throws readable errors for invalid files and unsafe names', async () => {
    await expect(loadBank('/missing', '../secret')).rejects.toThrow('无效的题库名称');
    await expect(loadBank('/missing', 'unknown')).rejects.toThrow('无法读取题库 "unknown"');
  });
});

describe('selectBankItems', () => {
  it('distributes selections evenly within each tier without repeats in a selection', () => {
    const bank = makeBank();
    const selections = Array.from(
      { length: bank.items.length },
      (_, requestIndex) => selectBankItems(bank, 1, requestIndex, 42)[0]
    );
    const counts = new Map(bank.items.map(item => [item.id, 0]));
    for (const item of selections) counts.set(item.id, counts.get(item.id) + 1);

    for (const tier of ['a', 'b']) {
      const tierCounts = bank.items
        .filter(item => item.tags.outputTier === tier)
        .map(item => counts.get(item.id));
      expect(Math.max(...tierCounts) - Math.min(...tierCounts)).toBeLessThanOrEqual(1);
    }
    expect(new Set(selectBankItems(bank, 4, 1, 42).map(item => item.id)).size).toBe(4);
  });

  it('repeats the same sequence for the same seed and changes it for another seed', () => {
    const bank = makeBank();
    const sequence = (seed) => Array.from(
      { length: bank.items.length },
      (_, requestIndex) => selectBankItems(bank, 1, requestIndex, seed)[0].id
    );

    expect(sequence(42)).toEqual(sequence(42));
    expect(sequence(42)).not.toEqual(sequence(43));
  });

  it('uses the default tier when outputTier is missing', () => {
    const bank = makeBank();
    for (const item of bank.items) delete item.tags.outputTier;
    const selected = selectBankItems(bank, 2, 0, 42);
    expect(selected).toHaveLength(2);
    expect(new Set(selected.map(item => item.id)).size).toBe(2);
  });

  it('uses only prompt as prompt material; expected text remains metadata', () => {
    const bank = {
      name: 'test',
      version: 1,
      items: [{
        id: 'fixed',
        prompt: '请输出固定内容',
        expected: { contentTokens: 1, text: '不得拼入 prompt 的答案' },
        tags: { genre: '测试' }
      }]
    };
    const [item] = selectBankItems(bank, 1, 0, 42);
    const prompt = item.prompt;

    expect(prompt).toBe('请输出固定内容');
    expect(prompt).not.toContain(item.expected.text);
  });

  it('resolves explicit IDs in the requested order for reproducible pinning', () => {
    const bank = makeBank();
    expect(selectBankItemsByIds(bank, ['b2', 'a1']).map(item => item.id)).toEqual(['b2', 'a1']);
    expect(() => selectBankItemsByIds(bank, ['missing'])).toThrow('不存在条目 id "missing"');
  });
});
