import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectBankItems } from '../src/bank.js';
import { runLlmBenchmarkTest } from '../src/llm-benchmark.js';
import { createMockSseServer } from './helpers/mock-sse-server.js';

let activeServer;

afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

describe('bank integration', () => {
  it('sends only selected prompts and records their IDs in raw results', async () => {
    const bank = {
      name: 'integration',
      version: 1,
      items: [
        {
          id: 'first',
          prompt: 'Prompt for first item',
          expected: { contentTokens: 1, text: 'FIRST-EXPECTED-ANSWER' },
          tags: { genre: 'test', outputTier: 'short' }
        },
        {
          id: 'second',
          prompt: 'Prompt for second item',
          expected: { contentTokens: 1, text: 'SECOND-EXPECTED-ANSWER' },
          tags: { genre: 'test', outputTier: 'short' }
        }
      ]
    };
    const bankMetadata = {
      name: bank.name,
      version: bank.version,
      hash: '123456789abc',
      itemCount: bank.items.length
    };
    const selected = Array.from(
      { length: 2 },
      (_, requestIndex) => selectBankItems(bank, 1, requestIndex, 42)[0]
    );
    activeServer = await createMockSseServer({ mode: 'usage-no-cache' });
    const consoleOutput = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = await runLlmBenchmarkTest({
        url: activeServer.url,
        model: 'mock-model',
        samples: selected.length,
        concurrency: 1,
        concurrencyMode: 'batch',
        maxOutputTokens: 4,
        timeout: 3000,
        retry: 0,
        warmupMode: 'none',
        generateInputText: async requestIndex => selected[requestIndex].prompt,
        bank: bankMetadata,
        bankItemIds: selected.map(item => item.id)
      });

      expect(activeServer.requests.map(request => request.firstUserContent)).toEqual(
        selected.map(item => item.prompt)
      );
      expect(activeServer.requests.every(request =>
        !request.firstUserContent.includes('EXPECTED-ANSWER')
      )).toBe(true);
      expect(result.raw.map(request => request.bankItemId)).toEqual(
        selected.map(item => item.id)
      );
      expect(result.config.bank).toEqual(bankMetadata);
    } finally {
      consoleOutput.mockRestore();
    }
  });
});
