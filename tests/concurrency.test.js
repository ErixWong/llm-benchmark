/**
 * 并发能力测试脚本
 * 独立运行的并发测试示例
 */

import dotenv from 'dotenv';
import chalk from 'chalk';
import { runConcurrencyTest } from '../src/concurrency.js';
import { generateReport } from '../src/reporter.js';

dotenv.config();

async function main() {
  console.log(chalk.bold.blue('\n📊 并发能力测试\n'));

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
  let concurrency = 10;
  let duration = 60;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && args[i + 1]) {
      concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '-d' && args[i + 1]) {
      duration = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const model = process.env.API_MODEL || 'gpt-3.5-turbo';

  console.log('测试参数:');
  console.log(`  并发数: ${concurrency}`);
  console.log(`  持续时间: ${duration}s`);
  console.log(`  API URL: ${url}`);
  console.log(`  模型: ${model}`);
  console.log('');

  try {
    const results = await runConcurrencyTest({
      url,
      apiKey,
      model,
      concurrency,
      duration
    });

    await generateReport({ concurrency: results }, './results');

    console.log(chalk.green('\n✅ 测试完成!\n'));
  } catch (error) {
    console.error(chalk.red('\n❌ 测试失败:'), error.message);
    process.exit(1);
  }
}

main();