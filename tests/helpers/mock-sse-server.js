import { createServer } from 'node:http';

const VALID_MODES = new Set([
  'no-usage',
  'usage-no-cache',
  'usage-explicit-zero-cache',
  'cache-without-prompt',
  'cache-aware'
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 启动仅供测试使用的本地 OpenAI-compatible SSE 服务。
 *
 * @param {{
 *   mode?:'no-usage'|'usage-no-cache'|'usage-explicit-zero-cache'|'cache-without-prompt'|'cache-aware',
 *   prefixes?:string[],
 *   hitDelayMs?:number,
 *   missDelayMs?:number,
 *   generationDelayMs?:number,
 *   completionTokens?:number,
 *   failContents?:string[]
 * }} options
 * @returns {Promise<{url:string,requests:Array<Object>,close:()=>Promise<void>}>}
 */
export async function createMockSseServer({
  mode = 'cache-aware',
  prefixes = [],
  hitDelayMs = 5,
  missDelayMs = 60,
  generationDelayMs = 3,
  completionTokens = 1,
  failContents = []
} = {}) {
  if (!VALID_MODES.has(mode)) {
    throw new RangeError(`无效的 mock SSE 模式: ${mode}`);
  }

  const requests = [];
  const seenPrefixes = new Set();
  let inFlight = 0;
  let maxConcurrent = 0;
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

      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      let released = false;
      const releaseRequest = () => {
        if (released) return;
        inFlight--;
        released = true;
      };
      response.once('finish', releaseRequest);
      response.once('close', releaseRequest);

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

      if (failContents.includes(firstUserContent)) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Intentional mock request failure' }));
        return;
      }

      void (async () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        await sleep(cacheHit ? hitDelayMs : missDelayMs);
        response.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: 'ok' } }]
        })}\n\n`);
        await sleep(generationDelayMs);

        if (mode !== 'no-usage') {
          const usage = {
            completion_tokens: completionTokens
          };
          if (mode !== 'cache-without-prompt') {
            usage.prompt_tokens = Math.max(300, String(firstUserContent ?? '').length);
          }
          if (mode === 'cache-aware') {
            usage.prompt_tokens_details = {
              cached_tokens: cacheHit ? usage.prompt_tokens - 100 : 0
            };
          } else if (mode === 'usage-explicit-zero-cache') {
            usage.prompt_tokens_details = { cached_tokens: 0 };
          } else if (mode === 'cache-without-prompt') {
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
    get maxConcurrent() {
      return maxConcurrent;
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    })
  };
}
