#!/usr/bin/env node

/**
 * LLM API Benchmark Tool
 * API端点并发能力与Token生成速度测试工具
 */

import { program } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { runConcurrencyTest } from './concurrency.js';
import { runLlmBenchmarkTest } from './llm-benchmark.js';
import { generateReport } from './reporter.js';
import { countMessagesTokens } from './context-generator.js';

// 加载环境变量
dotenv.config();

// 提示词模板 - 用于大样本测试
const PROMPT_TEMPLATE = '请从下列样本中选取一个进行仿写扩写。\n\n';

// 简单默认提示词 - 用于非样本测试
const SIMPLE_PROMPT = '请写一篇关于人工智能发展历程的文章，包括重要的里程碑事件和未来展望。';

program
  .name('llm-benchmark')
  .description('LLM API性能基准测试工具')
  .version('1.0.0');

/**
 * 安全解析整数，验证NaN
 * @param {string} value - 字符串值
 * @param {number} defaultValue - 默认值
 * @param {string} name - 参数名称(用于错误提示)
 * @returns {number} 解析后的整数
 */
function safeParseInt(value, defaultValue, name) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(chalk.yellow(`⚠️ 参数 ${name} 值 "${value}" 不是有效数字，使用默认值 ${defaultValue}`));
    return defaultValue;
  }
  return parsed;
}

/**
 * 递归扫描目录获取所有样本文件
 * @param {string} dir - 目录路径
 * @param {string} baseDir - 基准目录
 * @returns {Promise<string[]>} 样本文件列表
 */
async function scanSampleFiles(dir, baseDir = dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await scanSampleFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.txt')) {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  
  return files;
}

/**
 * 创建动态生成输入文本的函数
 * @param {number} sampleCount - 样本数量
 * @param {string[]} sampleFiles - 样本文件列表
 * @returns {Function} 生成输入文本的函数
 */
function createInputGenerator(sampleCount, sampleFiles) {
  return async () => {
    if (sampleCount > 0 && sampleFiles.length > 0) {
      const shuffled = [...sampleFiles].sort(() => Math.random() - 0.5);
      const selectedFiles = shuffled.slice(0, Math.min(sampleCount, sampleFiles.length));
      
      const dataDir = path.join(process.cwd(), 'data');
      const contents = await Promise.all(
        selectedFiles.map(f => fs.readFile(path.join(dataDir, f), 'utf-8'))
      );
      
      if (process.env.DEBUG) {
        console.log(chalk.gray(`选中样本: ${selectedFiles.join(', ')}`));
      }
      
      return PROMPT_TEMPLATE + contents.join('\n\n---\n\n');
    }
    return SIMPLE_PROMPT;
  };
}

// 并发测试命令
program
  .command('concurrency')
  .description('运行并发能力测试')
  .option('-c, --concurrency <number>', '并发数', '10')
  .option('-d, --duration <seconds>', '测试持续时间(秒)', '60')
  .option('-r, --ramp-up <seconds>', '预热时间(秒)', '10')
  .option('-u, --url <url>', 'API端点URL')
  .option('-k, --api-key <key>', 'API密钥')
  .option('-m, --model <model>', '模型名称', process.env.API_MODEL || 'gpt-3.5-turbo')
  .option('-o, --output <dir>', '输出目录', './results')
  .action(async (options) => {
    console.log(chalk.blue('🚀 开始并发能力测试...'));
    console.log(chalk.gray(`模型: ${options.model}`));
    try {
      const results = await runConcurrencyTest({
        concurrency: safeParseInt(options.concurrency, 10, 'concurrency'),
        duration: safeParseInt(options.duration, 60, 'duration'),
        rampUp: safeParseInt(options.rampUp, 10, 'rampUp'),
        url: options.url || process.env.API_BASE_URL,
        apiKey: options.apiKey || process.env.API_KEY,
        model: options.model,
        outputDir: options.output
      });
      console.log(chalk.green('✅ 测试完成!'));
      await generateReport(results, options.output);
    } catch (error) {
      console.error(chalk.red('❌ 测试失败:'), error.message);
      process.exit(1);
    }
  });

// Token速度测试命令
program
  .command('token-speed')
  .description('运行Token生成速度测试')
  .option('-c, --concurrency <number>', '并发数', '4')
  .option('-r, --rounds <number>', '采样轮数，总采样数 = 并发数 × 轮数', '5')
  .option('-n, --sample-count <number>', '每次请求随机抽取的样本数量（0表示使用简单prompt）', '0')
  .option('-m, --max-output <number>', '最大输出Token数', '30000')
  .option('--concurrency-mode <mode>', '并发模式: batch（批次）或 pipeline（流水线）', 'pipeline')
  .option('-t, --timeout <seconds>', '请求超时时间(秒)', '90')
  .option('-u, --url <url>', 'API端点URL')
  .option('-k, --api-key <key>', 'API密钥')
  .option('--model <model>', '模型名称', process.env.API_MODEL || 'gpt-3.5-turbo')
  .option('--system-prompt <prompt>', '系统提示词')
  .option('-o, --output <dir>', '输出目录', './results')
  .action(async (options) => {
    console.log(chalk.blue('⚡ 开始Token生成速度测试...'));
    
    const url = options.url || process.env.API_BASE_URL;
    const apiKey = options.apiKey || process.env.API_KEY;
    
    if (!url) {
      console.error(chalk.red('❌ 错误: 请在 .env 文件中配置 API_BASE_URL 或使用 -u 参数'));
      process.exit(1);
    }
    
    const concurrency = safeParseInt(options.concurrency, 4, 'concurrency');
    const rounds = safeParseInt(options.rounds, 5, 'rounds');
    const sampleCount = safeParseInt(options.sampleCount, 0, 'sampleCount');
    const maxOutputTokens = safeParseInt(options.maxOutput, 30000, 'maxOutput');
    const timeout = safeParseInt(options.timeout, 90, 'timeout') * 1000;
    const concurrencyMode = options.concurrencyMode;
    const samples = concurrency * rounds;
    
    // 验证并发模式
    if (!['batch', 'pipeline'].includes(concurrencyMode)) {
      console.warn(chalk.yellow(`⚠️ 无效的并发模式 "${concurrencyMode}"，使用默认值 "pipeline"`));
    }
    
    // 扫描样本文件
    let sampleFiles = [];
    if (sampleCount > 0) {
      try {
        const dataDir = path.join(process.cwd(), 'data');
        sampleFiles = await scanSampleFiles(dataDir);
        sampleFiles = sampleFiles.filter(f => {
          const name = path.basename(f);
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
    
    // 创建输入生成器
    const generateInputText = createInputGenerator(sampleCount, sampleFiles);
    
    // 预估 token 数
    const sampleInput = await generateInputText();
    const estimatedTokens = countMessagesTokens([{ role: 'user', content: sampleInput }]);
    
    const model = options.model;
    
    console.log(chalk.gray(`模型: ${model}`));
    console.log('测试参数:');
    console.log(`  并发数: ${concurrency}`);
    console.log(`  采样轮数: ${rounds}`);
    console.log(`  总采样数: ${samples} (${concurrency} × ${rounds})`);
    if (sampleCount > 0) {
      console.log(`  每次随机抽取: ${sampleCount} 个样本`);
    } else {
      console.log(`  使用默认简单Prompt`);
    }
    console.log(`  预估输入Token数: ${estimatedTokens}`);
    console.log(`  最大输出Token数: ${maxOutputTokens}`);
    console.log(`  请求超时: ${timeout / 1000}s`);
    console.log(`  并发模式: ${concurrencyMode === 'pipeline' ? '流水线' : '批次'}`);
    console.log(`  API URL: ${url}`);
    console.log('');
    
    try {
      const results = await runLlmBenchmarkTest({
        url,
        apiKey,
        model,
        inputTokens: estimatedTokens,
        maxOutputTokens,
        samples,
        concurrency,
        concurrencyMode,
        sampleCount,
        generateInputText,
        timeout
      });
      
      // 为每份报告创建单独的目录
      const now = new Date();
      const pad = (n) => n.toString().padStart(2, '0');
      const localTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const reportDir = `${options.output}/report-${localTimestamp}`;
      
      await generateReport({ tokenSpeed: results }, reportDir);
      console.log(chalk.green('✅ 测试完成!'));
    } catch (error) {
      console.error(chalk.red('❌ 测试失败:'), error.message);
      process.exit(1);
    }
  });

// 完整测试命令
program
  .command('all')
  .description('运行所有测试')
  .option('-o, --output <dir>', '输出目录', './results')
  .action(async (options) => {
    console.log(chalk.blue('🔬 开始完整性能测试...'));
    try {
      // 并发测试
      console.log(chalk.cyan('\n📊 阶段1: 并发能力测试'));
      const concurrencyResults = await runConcurrencyTest({
        url: process.env.API_BASE_URL,
        apiKey: process.env.API_KEY,
        outputDir: options.output
      });

      // Token速度测试
      console.log(chalk.cyan('\n📊 阶段2: Token生成速度测试'));
      const tokenSpeedResults = await runLlmBenchmarkTest({
        url: process.env.API_BASE_URL,
        apiKey: process.env.API_KEY,
        outputDir: options.output
      });

      // 生成综合报告
      console.log(chalk.cyan('\n📊 生成测试报告...'));
      await generateReport({
        concurrency: concurrencyResults,
        tokenSpeed: tokenSpeedResults
      }, options.output);

      console.log(chalk.green('✅ 所有测试完成!'));
    } catch (error) {
      console.error(chalk.red('❌ 测试失败:'), error.message);
      process.exit(1);
    }
  });

program.parse();