import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { createHttpClient, normalizeApiUrl, DEFAULT_TIMEOUT } from '../src/http-client.js';

dotenv.config();

const artifactsDirArg = process.argv[2];
if (!artifactsDirArg) {
  throw new Error('用法: node tests/normalize-raw-api-output.mjs <artifacts-dir>');
}

const artifactsDir = path.resolve(process.cwd(), artifactsDirArg);
const metadata = JSON.parse(await fs.readFile(path.join(artifactsDir, 'metadata.json'), 'utf-8'));
const parsedEvents = JSON.parse(await fs.readFile(path.join(artifactsDir, 'parsed-events.json'), 'utf-8'));

const url = process.env.API_BASE_URL;
const apiKey = process.env.API_KEY;
const model = process.env.API_MODEL;
const userAgent = process.env.USER_AGENT || 'llm-benchmark/raw-normalizer';
const timeout = DEFAULT_TIMEOUT;

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

const normalizationPrompt = [
  '你是一个 API 响应归一化器。',
  '你会读取一组流式 chat completion 事件，并输出严格 JSON。',
  '只输出 JSON，不要输出解释。',
  '目标结构如下：',
  '{',
  '  "providerFormat": string,',
  '  "hasUsage": boolean,',
  '  "usage": { "promptTokens": number|null, "completionTokens": number|null, "source": string|null },',
  '  "assistantRoleSeen": boolean,',
  '  "visibleContent": string,',
  '  "reasoningContent": string,',
  '  "sawThinkTag": boolean,',
  '  "finishReason": string|null,',
  '  "timings": object|null,',
  '  "notes": string[]',
  '}',
  '归一化规则：',
  '1. 如果存在 usage，提取 prompt/completion token。',
  '2. 如果没有 usage，但存在 timings.prompt_n/predicted_n，则写入 usage，并把 source 设为 "timings"。',
  '3. reasoningContent 只收集明显属于推理或思维标记的内容。',
  '4. visibleContent 收集最终用户可见回答。',
  '5. 如果看到 </think> 或类似标签，sawThinkTag=true。',
  '6. providerFormat 用一句短语概括，例如 "openai-compatible stream with timings"。',
  '7. notes 里记录你观察到的结构特征。'
].join('\n');

const analysisInput = {
  metadata,
  parsedEvents
};

const response = await httpClient.post(normalizedUrl, {
  model,
  messages: [
    { role: 'system', content: normalizationPrompt },
    { role: 'user', content: JSON.stringify(analysisInput, null, 2) }
  ],
  max_tokens: 1200,
  stream: false,
  temperature: 0
});

const normalizedText = response.data?.choices?.[0]?.message?.content || '';

let normalizedJson;
try {
  normalizedJson = JSON.parse(normalizedText);
} catch (error) {
  normalizedJson = {
    parseError: error.message,
    rawModelOutput: normalizedText
  };
}

await fs.writeFile(
  path.join(artifactsDir, 'normalized-by-ai.json'),
  JSON.stringify(normalizedJson, null, 2)
);

console.log(JSON.stringify({
  artifactsDir,
  outputFile: path.join(artifactsDir, 'normalized-by-ai.json'),
  parsed: !normalizedJson.parseError
}, null, 2));
