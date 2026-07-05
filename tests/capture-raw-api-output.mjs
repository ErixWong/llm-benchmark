import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { createHttpClient, normalizeApiUrl, DEFAULT_TIMEOUT } from '../src/http-client.js';

dotenv.config();

const url = process.env.API_BASE_URL;
const apiKey = process.env.API_KEY;
const model = process.env.API_MODEL;
const userAgent = process.env.USER_AGENT || 'llm-benchmark/raw-capture';
const timeout = DEFAULT_TIMEOUT;
const prompt = process.env.RAW_API_PROMPT || '请只输出一句简短的中文测试响应，并结束。';

if (!url) {
  throw new Error('缺少 API_BASE_URL');
}

if (!model) {
  throw new Error('缺少 API_MODEL');
}

const normalizedUrl = normalizeApiUrl(url);
const httpClient = createHttpClient({
  baseURL: url,
  timeout,
  headers: {
    'User-Agent': userAgent,
    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
  }
});

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
const outputDir = path.join(process.cwd(), 'tests', 'artifacts', `raw-api-${stamp}`);

await fs.mkdir(outputDir, { recursive: true });

const requestBody = {
  model,
  messages: [
    { role: 'user', content: prompt }
  ],
  max_tokens: 256,
  stream: true
};

const response = await httpClient.post(normalizedUrl, requestBody, {
  responseType: 'stream'
});

const rawChunks = [];
const rawChunkStrings = [];

await new Promise((resolve, reject) => {
  response.data.on('data', (chunk) => {
    const chunkString = chunk.toString();
    rawChunks.push({
      timestamp: new Date().toISOString(),
      byteLength: chunk.length,
      text: chunkString
    });
    rawChunkStrings.push(chunkString);
  });

  response.data.on('end', resolve);
  response.data.on('error', reject);
});

const rawSseText = rawChunkStrings.join('');
const parsedEvents = rawSseText
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('data: '))
  .map(line => line.slice(6));

const parsedJsonEvents = parsedEvents
  .filter(line => line !== '[DONE]')
  .map((line, index) => {
    try {
      return { index, ok: true, json: JSON.parse(line) };
    } catch (error) {
      return { index, ok: false, error: error.message, raw: line };
    }
  });

const metadata = {
  capturedAt: new Date().toISOString(),
  request: {
    url,
    normalizedUrl,
    model,
    timeout,
    userAgent,
    prompt,
    requestBody
  },
  response: {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  },
  summary: {
    chunkCount: rawChunks.length,
    eventCount: parsedEvents.length,
    jsonEventCount: parsedJsonEvents.filter(event => event.ok).length,
    hasDoneEvent: parsedEvents.includes('[DONE]')
  }
};

await fs.writeFile(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
await fs.writeFile(path.join(outputDir, 'raw-chunks.json'), JSON.stringify(rawChunks, null, 2));
await fs.writeFile(path.join(outputDir, 'raw-sse.txt'), rawSseText);
await fs.writeFile(path.join(outputDir, 'parsed-events.json'), JSON.stringify(parsedJsonEvents, null, 2));

console.log(JSON.stringify({
  outputDir,
  status: response.status,
  chunkCount: rawChunks.length,
  eventCount: parsedEvents.length,
  hasDoneEvent: parsedEvents.includes('[DONE]')
}, null, 2));
