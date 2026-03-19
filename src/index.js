#!/usr/bin/env node

/**
 * LLM API Benchmark Tool
 * API端点并发能力与Token生成速度测试工具
 */

import { program } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { runConcurrencyTest } from './concurrency.js';
import { runLlmBenchmarkTest } from './llm-benchmark.js';
import { generateReport } from './reporter.js';

// 加载环境变量
dotenv.config();

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
  .option('-i, --input-tokens <number>', '输入Token数量', '100')
  .option('-m, --max-output <number>', '最大输出Token数量', '500')
  .option('-c, --concurrency <number>', '并发数', '1')
  .option('-s, --samples <number>', '采样次数', '10')
  .option('-u, --url <url>', 'API端点URL')
  .option('-k, --api-key <key>', 'API密钥')
  .option('--model <model>', '模型名称', process.env.API_MODEL || 'gpt-3.5-turbo')
  .option('--system-prompt <prompt>', '系统提示词')
  .option('--context-rounds <number>', '多轮对话轮数', '0')
  .option('-o, --output <dir>', '输出目录', './results')
  .action(async (options) => {
    console.log(chalk.blue('⚡ 开始Token生成速度测试...'));
    console.log(chalk.gray(`模型: ${options.model}`));
    try {
      const results = await runLlmBenchmarkTest({
        inputTokens: safeParseInt(options.inputTokens, 100, 'inputTokens'),
        maxOutputTokens: safeParseInt(options.maxOutput, 500, 'maxOutput'),
        concurrency: safeParseInt(options.concurrency, 1, 'concurrency'),
        samples: safeParseInt(options.samples, 10, 'samples'),
        url: options.url || process.env.API_BASE_URL,
        apiKey: options.apiKey || process.env.API_KEY,
        model: options.model,
        systemPrompt: options.systemPrompt,
        contextRounds: safeParseInt(options.contextRounds, 0, 'contextRounds'),
        outputDir: options.output
      });
      console.log(chalk.green('✅ 测试完成!'));
      await generateReport(results, options.output);
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