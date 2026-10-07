import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('cache probe documentation', () => {
  it('documents that insufficient samples do not suppress a computable TTFT ratio', async () => {
    const metrics = await readFile(new URL('../docs/metrics.md', import.meta.url), 'utf8');
    const ratioDefinition = metrics.split('\n').find((line) => line.startsWith('| `ttftRatio` |'));

    expect(ratioDefinition).toContain('样本不足本身不会令比值为 `null`');
    expect(ratioDefinition).toContain('仅供参考、不得据此下结论');
    expect(ratioDefinition).toContain('insufficientSamples');
  });

  it('lists promptTokens among the cache probe raw fields in the changelog', async () => {
    const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    const entryStart = changelog.indexOf('- `--cache-probe`');
    const nextEntryStart = changelog.indexOf('\n- ', entryStart + 1);
    const cacheProbeEntry = changelog.slice(entryStart, nextEntryStart);

    expect(entryStart).toBeGreaterThanOrEqual(0);
    expect(nextEntryStart).toBeGreaterThan(entryStart);
    expect(cacheProbeEntry).toContain('`promptTokens`');
  });
});
