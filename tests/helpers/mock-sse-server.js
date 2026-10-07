import { createServer } from 'node:http';

const VALID_MODES = new Set([
  'no-usage',
  'usage-no-cache',
  'usage-explicit-zero-cache',
  'cache-aware'
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 启动仅供测试使用的本地 OpenAI-compatible SSE 服务。
 *
 * @param {{
 *   mode?:'no-usage'|'usage-no-cache'|'usage-explicit-zero-cache'|'cache-aware',
 *   prefixes?:string[],
 *   hitDelayMs?:number,
 *   missDelayMs?:number,
 *   generationDelayMs?:number,
 *   completionTokens?:number
 * }} options
 * @returns {Promise<{url:string,requests:Array<Object>,close:()=>Promise<void>}>}
 */
export async function createMockSseServer({
  mode = 'cache-aware',
  prefixes = [],
  hitDelayMs = 5,
  missDelayMs = 60,
  generationDelayMs = 3,
  completionTokens = 1
} = {}) {
  if (!VALID_MODES.has(mode)) {
    throw new RangeError(`无效的 mock SSE 模式: ${mode}`);
  }

  const requests = [];
  const seenPrefixes = new Set();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Request body must be JSON' }));
        return;
      }

      const firstUserContent = body.messages?.find((message) => message.role === 'user')?.content;
      const prefix = prefixes.find((candidate) => firstUserContent?.startsWith(candidate));
      const cacheHit = Boolean(prefix && seenPrefixes.has(prefix));
      if (prefix) seenPrefixes.add(prefix);

      const record = {
        order: requests.length,
        firstUserContent,
        body,
        cacheHit,
        matchedPrefix: prefix ?? null
      };
      requests.push(record);

      void (async () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        await sleep(cacheHit ? hitDelayMs : missDelayMs);
        response.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: 'ok' } }]
        })}\n\n`);
        await sleep(generationDelayMs);

        if (mode !== 'no-usage') {
          const promptTokens = Math.max(300, String(firstUserContent ?? '').length);
          const usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens
          };
          if (mode === 'cache-aware') {
            usage.prompt_tokens_details = {
              cached_tokens: cacheHit ? promptTokens - 100 : 0
            };
          } else if (mode === 'usage-explicit-zero-cache') {
            usage.prompt_tokens_details = { cached_tokens: 0 };
          }
          response.write(`data: ${JSON.stringify({
            choices: [{ delta: {} }],
            usage
          })}\n\n`);
        }

        response.write('data: [DONE]\n\n');
        response.end();
      })().catch((error) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'application/json' });
        }
        response.end(JSON.stringify({ error: error.message }));
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    })
  };
}
