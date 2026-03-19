#!/usr/bin/env node

/**
 * 计算data目录下所有样本文件的token数量
 */

import { encode } from 'gpt-tokenizer';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const dataDir = join(process.cwd(), 'data');

// 获取所有sample文件
const files = readdirSync(dataDir)
  .filter(f => f.startsWith('sample-8k') && f.endsWith('.txt'))
  .sort();

console.log('样本文件Token计数报告\n');
console.log('=' .repeat(60));
console.log('文件名'.padEnd(25) + '字符数'.padStart(10) + 'Token数'.padStart(12));
console.log('-'.repeat(60));

let totalChars = 0;
let totalTokens = 0;
const results = [];

for (const file of files) {
  const filePath = join(dataDir, file);
  const content = readFileSync(filePath, 'utf-8');
  const tokens = encode(content);
  const charCount = content.length;
  const tokenCount = tokens.length;
  
  totalChars += charCount;
  totalTokens += tokenCount;
  
  results.push({ file, charCount, tokenCount });
  console.log(file.padEnd(25) + charCount.toString().padStart(10) + tokenCount.toString().padStart(12));
}

console.log('-'.repeat(60));
console.log('总计'.padEnd(25) + totalChars.toString().padStart(10) + totalTokens.toString().padStart(12));
console.log('=' .repeat(60));

// 计算可组合的上下文大小
console.log('\n可组合的上下文大小:');
console.log('-'.repeat(40));

const contextSizes = [
  { name: '8K', files: 1 },
  { name: '16K', files: 2 },
  { name: '32K', files: 4 },
  { name: '64K', files: 8 },
  { name: '128K', files: 16 }
];

for (const size of contextSizes) {
  if (size.files <= files.length) {
    const tokens = results.slice(0, size.files).reduce((sum, r) => sum + r.tokenCount, 0);
    console.log(`${size.name} (${size.files}个文件): ~${tokens.toLocaleString()} tokens`);
  }
}

// 输出JSON格式数据
console.log('\nJSON数据 (可复制到其他工具使用):');
console.log(JSON.stringify({
  files: results,
  summary: {
    totalFiles: files.length,
    totalChars,
    totalTokens,
    avgTokensPerFile: Math.round(totalTokens / files.length)
  }
}, null, 2));