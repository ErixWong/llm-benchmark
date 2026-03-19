/**
 * LLM API 基准测试脚本
 * 测试API端点的Token生成速度、并发能力等性能指标
 * 
 * 参数说明：
 *   -c, --concurrency <num>   并发数（默认: 4）
 *   -r, --rounds <num>        采样轮数，总采样数 = 并发数 × 轮数（默认: 5）
 *   -n, --sample-count <num>  每次请求随机抽取的8k样本数量（默认: 0，使用简单prompt）
 *   -m, --max-output <num>    最大输出Token数（默认: 30000）
 *   --concurrency-mode <mode> 并发模式: batch（批次）或 pipeline（流水线）
 * 
 * 示例：
 *   node tests/llm-benchmark.test.js -c 4 -r 5 -n 2
 *   # 并发4，轮数5，共20次采样，每次抽取2个样本
 */

import dotenv from 'dotenv';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { runLlmBenchmarkTest } from '../src/llm-benchmark.js';
import { generateReport } from '../src/reporter.js';
import { countMessagesTokens } from '../src/context-generator.js';

dotenv.config();

// 提示词模板 - 用于大样本测试
const PROMPT_TEMPLATE = '请从下列样本中选取一个进行仿写扩写。\n\n';

// 简单默认提示词 - 用于非样本测试
const SIMPLE_PROMPT = '请写一篇关于人工智能发展历程的文章，包括重要的里程碑事件和未来展望。';

async function main() {
  console.log(chalk.bold.blue('\n⚡ Token生成速度测试\n'));

  const url = process.env.API_BASE_URL;
  const apiKey = process.env.API_KEY;

  if (!url) {
    console.error(chalk.red('❌ 错误: 请在 .env 文件中配置 API_BASE_URL'));
    console.log(chalk.yellow('\n使用方法:'));
    console.log('  1. 复制 .env.example 为 .env');
    console.log('  2. 配置 API_BASE_URL 和 API_KEY');
    console.log('  3. 重新运行测试');
    process.exit(1);
  }

  // 解析命令行参数
  const args = process.argv.slice(2);
  let maxOutputTokens = parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || 30000;
  let concurrency = parseInt(process.env.DEFAULT_CONCURRENCY, 10) || 4;
  let rounds = parseInt(process.env.ROUNDS, 10) || 5;  // 采样轮数
  let concurrencyMode = process.env.CONCURRENCY_MODE || 'pipeline';
  let sampleCount = parseInt(process.env.SAMPLE_COUNT, 10) || 0;  // 每次请求抽取的样本数，0表示使用简单prompt
  let timeout = parseInt(process.env.DEFAULT_TIMEOUT, 10) || 90000;  // 请求超时时间（毫秒）

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-m' || args[i] === '--max-output') && args[i + 1]) {
      maxOutputTokens = parseInt(args[i + 1], 10);
      i++;
    } else if ((args[i] === '-c' || args[i] === '--concurrency') && args[i + 1]) {
      concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if ((args[i] === '-r' || args[i] === '--rounds') && args[i + 1]) {
      rounds = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--concurrency-mode' && args[i + 1]) {
      concurrencyMode = args[i + 1];
      i++;
    } else if ((args[i] === '-n' || args[i] === '--sample-count') && args[i + 1]) {
      sampleCount = parseInt(args[i + 1], 10);
      i++;
    } else if ((args[i] === '-t' || args[i] === '--timeout') && args[i + 1]) {
      // 支持秒或毫秒输入：如果值小于1000认为是秒，否则是毫秒
      const inputVal = parseInt(args[i + 1], 10);
      timeout = inputVal < 1000 ? inputVal * 1000 : inputVal;
      i++;
    }
  }

  // 验证并发模式
  if (!['batch', 'pipeline'].includes(concurrencyMode)) {
    console.warn(chalk.yellow(`⚠️ 无效的并发模式 "${concurrencyMode}"，使用默认值 "pipeline"`));
    concurrencyMode = 'pipeline';
  }

  // 计算总采样数 = 并发数 × 轮数
  const samples = concurrency * rounds;

  // 递归扫描目录获取所有样本文件
  async function scanSampleFiles(dir, baseDir = dir) {
    const files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 递归扫描子目录
        const subFiles = await scanSampleFiles(fullPath, baseDir);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.txt')) {
        // 记录相对于data目录的路径
        files.push(path.relative(baseDir, fullPath));
      }
    }
    
    return files;
  }

  // 读取所有可用样本文件
  let sampleFiles = [];
  if (sampleCount > 0) {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      
      // 递归扫描 data 目录及其子目录
      sampleFiles = await scanSampleFiles(dataDir);
      
      // 过滤出所有样本文件（支持多种命名格式）
      sampleFiles = sampleFiles.filter(f => {
        const name = path.basename(f);
        // 匹配各种样本文件格式
        return name.includes('-8k') ||
               name.includes('-16k') ||
               name.startsWith('sample-') ||
               name.startsWith('novel-') ||
               name.startsWith('tech-news-') ||
               name.startsWith('conversation-') ||
               name.startsWith('code-samples-') ||
               name.startsWith('multimodal-');
      });
      
      if (sampleFiles.length === 0) {
        console.error(chalk.red('❌ 没有找到样本文件'));
        process.exit(1);
      }
      
      // 按目录分类统计
      const categories = {};
      for (const f of sampleFiles) {
        const dir = path.dirname(f);
        const category = dir === '.' ? 'root' : dir.replace(/\\/g, '/');
        categories[category] = (categories[category] || 0) + 1;
      }
      
      console.log(chalk.gray(`📚 找到 ${sampleFiles.length} 个样本文件:`));
      for (const [cat, count] of Object.entries(categories)) {
        console.log(chalk.gray(`   ${cat}: ${count} 个`));
      }
    } catch (error) {
      console.error(chalk.red(`❌ 无法读取样本目录: ${error.message}`));
      process.exit(1);
    }
  }

  // 动态生成输入文本的函数
  const generateInputText = async () => {
    if (sampleCount > 0 && sampleFiles.length > 0) {
      // 随机抽取 sampleCount 个样本
      const shuffled = [...sampleFiles].sort(() => Math.random() - 0.5);
      const selectedFiles = shuffled.slice(0, Math.min(sampleCount, sampleFiles.length));
      
      const dataDir = path.join(process.cwd(), 'data');
      const contents = await Promise.all(
        selectedFiles.map(f => fs.readFile(path.join(dataDir, f), 'utf-8'))
      );
      
      // 显示选中的样本（用于调试）
      if (process.env.DEBUG) {
        console.log(chalk.gray(`选中样本: ${selectedFiles.join(', ')}`));
      }
      
      // 加上提示词
      return PROMPT_TEMPLATE + contents.join('\n\n---\n\n');
    }
    // sampleCount=0 时返回简单prompt
    return SIMPLE_PROMPT;
  };

  // 预估单个请求的 token 数
  let estimatedTokensPerRequest = 0;
  const sampleInput = await generateInputText();
  if (sampleInput) {
    estimatedTokensPerRequest = countMessagesTokens([{ role: 'user', content: sampleInput }]);
  }

  const model = process.env.API_MODEL || 'gpt-3.5-turbo';

  console.log('测试参数:');
  console.log(`  并发数: ${concurrency}`);
  console.log(`  采样轮数: ${rounds}`);
  console.log(`  总采样数: ${samples} (${concurrency} × ${rounds})`);
  if (sampleCount > 0) {
    console.log(`  每次随机抽取: ${sampleCount} 个样本`);
  } else {
    console.log(`  使用默认简单Prompt`);
  }
  console.log(`  预估输入Token数: ${estimatedTokensPerRequest}`);
  console.log(`  最大输出Token数: ${maxOutputTokens}`);
  console.log(`  请求超时: ${timeout >= 1000 ? (timeout / 1000) + 's' : timeout + 'ms'}`);
  console.log(`  并发模式: ${concurrencyMode === 'pipeline' ? '流水线' : '批次'}`);
  console.log(`  API URL: ${url}`);
  console.log(`  模型: ${model}`);
  console.log('');

  try {
    const results = await runLlmBenchmarkTest({
      url,
      apiKey,
      model,
      inputTokens: estimatedTokensPerRequest,
      maxOutputTokens,
      samples,
      concurrency,
      concurrencyMode,
      sampleCount,
      generateInputText,
      timeout
    });

    // 为每份报告创建单独的目录（使用本地时区 UTC+8）
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const localTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const reportDir = `./results/report-${localTimestamp}`;
    
    await generateReport({ tokenSpeed: results }, reportDir);

    console.log(chalk.green('\n✅ 测试完成!\n'));
  } catch (error) {
    console.error(chalk.red('\n❌ 测试失败:'), error.message);
    process.exit(1);
  }
}

main();