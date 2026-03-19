/**
 * 基准测试入口
 * 执行完整的性能基准测试
 */

import dotenv from 'dotenv';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { runConcurrencyTest } from './concurrency.js';
import { runLlmBenchmarkTest } from './llm-benchmark.js';
import { generateReport } from './reporter.js';

dotenv.config();

async function main() {
  console.log(chalk.bold.blue('\n🚀 LLM API Benchmark Tool\n'));
  console.log(chalk.gray('━'.repeat(50)));

  // 加载配置
  const config = loadConfig();
  
  const url = config.api.baseUrl || process.env.API_BASE_URL;
  const apiKey = config.api.apiKey || process.env.API_KEY;
  const model = config.api.model || process.env.API_MODEL || 'gpt-3.5-turbo';

  if (!url) {
    console.error(chalk.red('❌ 错误: 请在 .env 文件中配置 API_BASE_URL'));
    process.exit(1);
  }

  console.log(chalk.cyan('测试配置:'));
  console.log(`  API URL: ${url}`);
  console.log(`  API Key: ${apiKey ? '已配置' : '未配置'}`);
  console.log(`  模型: ${model}`);
  console.log(chalk.gray('━'.repeat(50)));

  const results = {};

  try {
    // 阶段1: 并发测试
    console.log(chalk.bold.cyan('\n📊 阶段1: 并发能力测试\n'));
    results.concurrency = await runConcurrencyTest({
      url,
      apiKey,
      model,
      concurrency: parseInt(process.env.DEFAULT_CONCURRENCY, 10) || config.test.concurrency.levels[2] || 10,
      duration: parseInt(process.env.DEFAULT_DURATION, 10) || config.test.concurrency.duration,
      rampUp: config.test.concurrency.rampUp
    });

    // 阶段2: Token速度测试
    console.log(chalk.bold.cyan('\n📊 阶段2: Token生成速度测试\n'));
    results.tokenSpeed = await runLlmBenchmarkTest({
      url,
      apiKey,
      model,
      inputTokens: parseInt(process.env.INPUT_TOKENS, 10) || config.test.tokenSpeed.inputTokens[0],
      maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || config.test.tokenSpeed.maxOutputTokens,
      samples: parseInt(process.env.TOKEN_TEST_SAMPLES, 10) || config.test.tokenSpeed.samples,
      warmupRequests: config.test.tokenSpeed.warmupRequests,
      systemPrompt: process.env.SYSTEM_PROMPT || null,
      contextRounds: parseInt(process.env.CONTEXT_ROUNDS, 10) || 0
    });

    // 生成报告
    console.log(chalk.bold.cyan('\n📄 生成测试报告\n'));
    const reportPaths = await generateReport(results, process.env.REPORT_OUTPUT_DIR || config.report.outputDir);

    console.log(chalk.bold.green('\n✅ 测试完成!\n'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log('报告路径:');
    console.log(`  JSON: ${reportPaths.jsonPath}`);
    console.log(`  Markdown: ${reportPaths.mdPath}`);
    console.log(`  HTML: ${reportPaths.htmlPath}`);
    console.log(chalk.gray('━'.repeat(50)));

  } catch (error) {
    console.error(chalk.red('\n❌ 测试失败:'), error.message);
    if (error.response) {
      console.error(chalk.red('响应状态:'), error.response.status);
      console.error(chalk.red('响应数据:'), error.response.data);
    }
    process.exit(1);
  }
}

main();