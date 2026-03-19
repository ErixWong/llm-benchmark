/**
 * 并发能力测试模块
 * 测试API端点的并发处理能力
 */

import autocannon from 'autocannon';
import chalk from 'chalk';
import ora from 'ora';
import { createHttpClient, validateParams, concurrencyTestRules, normalizeApiUrl, isErrorStatus } from './http-client.js';

/**
 * 运行并发测试
 * @param {Object} options - 测试选项
 * @returns {Promise<Object>} 测试结果
 */
export async function runConcurrencyTest(options) {
  const {
    concurrency = 10,
    duration = 60,
    rampUp = 10,
    url,
    apiKey,
    model = 'gpt-3.5-turbo',
    outputDir = './results'
  } = options;

  // 参数验证
  const validation = validateParams(options, concurrencyTestRules);
  if (!validation.valid) {
    throw new Error(`参数验证失败: ${validation.errors.join(', ')}`);
  }

  if (!url) {
    throw new Error('API URL is required. Set API_BASE_URL in .env or use --url option.');
  }

  // 规范化URL（用于autocannon，它不使用httpClient）
  const normalizedUrl = normalizeApiUrl(url);

  const spinner = ora(`运行并发测试 (并发数: ${concurrency}, 持续时间: ${duration}s)`).start();

  // 创建带重试的HTTP客户端（自动处理URL规范化）
  const httpClient = createHttpClient({
    baseURL: url, // createHttpClient会自动规范化
    timeout: 30000,
    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
  });

  try {
    // 构建请求头，仅在apiKey存在时添加Authorization
    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // 预热阶段 - 完善的错误处理
    if (rampUp > 0) {
      spinner.text = `预热中... (${rampUp}s)`;
      const warmupEndTime = Date.now() + rampUp * 1000;
      const warmupPromises = [];
      
      // 发送少量预热请求建立连接
      const warmupCount = Math.min(concurrency, 5);
      for (let i = 0; i < warmupCount; i++) {
        warmupPromises.push(
          executeWarmupWithRetry(httpClient, normalizedUrl, model, warmupEndTime, i)
        );
      }
      
      // 等待所有预热完成，捕获但不抛出错误
      const warmupResults = await Promise.allSettled(warmupPromises);
      const failedWarmups = warmupResults.filter(r => r.status === 'rejected');
      if (failedWarmups.length > 0) {
        console.log(chalk.yellow(`⚠️ ${failedWarmups.length}/${warmupCount} 预热请求失败，继续测试...`));
      }
      
      spinner.text = `运行并发测试 (并发数: ${concurrency}, 持续时间: ${duration}s)`;
    }

    const result = await autocannon({
      url: normalizedUrl,
      connections: concurrency,
      duration: duration,
      pipelining: 1,
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hello, this is a test message.' }],
        max_tokens: 50
      }),
      method: 'POST'
    });

    spinner.succeed('并发测试完成');

    // 处理结果
    const processedResult = processConcurrencyResult(result);
    
    // 打印摘要
    printConcurrencySummary(processedResult);

    return processedResult;
  } catch (error) {
    spinner.fail('并发测试失败');
    throw error;
  }
}

/**
 * 执行带重试的预热请求
 * @param {Object} httpClient - HTTP客户端
 * @param {string} url - API URL
 * @param {string} model - 模型名称
 * @param {number} warmupEndTime - 预热结束时间
 * @param {number} workerId - 工作线程ID
 * @returns {Promise<number>} 成功请求数
 */
async function executeWarmupWithRetry(httpClient, url, model, warmupEndTime, workerId) {
  let successCount = 0;
  const maxRetries = 3;
  
  while (Date.now() < warmupEndTime) {
    let retryCount = 0;
    let success = false;
    
    while (retryCount < maxRetries && !success) {
      try {
        // 使用空路径，因为 baseURL 已经包含完整路径
        const response = await httpClient.post('', {
          model: model,
          messages: [{ role: 'user', content: 'warmup' }],
          max_tokens: 5
        });
        
        if (response.status === 200 || response.status === 201) {
          success = true;
          successCount++;
        }
      } catch (error) {
        retryCount++;
        const status = error.response?.status;
        
        // 429限流处理
        if (status === 429) {
          const retryAfter = error.response?.headers?.['retry-after'];
          if (retryAfter) {
            const delay = parseInt(retryAfter, 10) * 1000 || 5000;
            console.log(chalk.yellow(`[Worker ${workerId}] 限流，等待 ${delay}ms`));
            await new Promise(resolve => setTimeout(resolve, Math.min(delay, 5000)));
            continue;
          }
        }
        
        // 非重试错误或达到最大重试次数
        if (retryCount >= maxRetries) {
          // 继续下一个请求
          break;
        }
        
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
    // 短暂休息避免过度请求
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return successCount;
}

/**
 * 处理并发测试结果
 * @param {Object} result - autocannon原始结果
 * @returns {Object} 处理后的结果
 */
function processConcurrencyResult(result) {
  // 计算真实错误数：网络错误 + 超时 + 非2xx响应
  const networkErrors = result.errors || 0;
  const timeouts = result.timeouts || 0;
  
  // 非2xx状态码也应该算作错误
  const non2xx = result.non2xx || 0;
  const statusCodes = result.statusCodeStats || {};
  
  // 统计4xx和5xx错误
  let httpErrors = 0;
  const errorDetails = [];
  
  for (const [code, stats] of Object.entries(statusCodes)) {
    const statusCode = parseInt(code, 10);
    if (isErrorStatus(statusCode)) {
      httpErrors += stats.count;
      errorDetails.push({
        code: statusCode,
        count: stats.count,
        category: statusCode >= 500 ? 'server_error' : 'client_error'
      });
    }
  }
  
  const totalErrors = networkErrors + timeouts + httpErrors;
  const totalRequests = result.requests?.total || 0;
  const successRequests = (result['2xx'] || 0);
  
  return {
    type: 'concurrency',
    timestamp: new Date().toISOString(),
    config: {
      url: result.url,
      concurrency: result.connections,
      duration: result.duration,
      pipelining: result.pipelining
    },
    metrics: {
      throughput: {
        rps: result.requests.average,
        minRps: result.requests.min,
        maxRps: result.requests.max,
        total: totalRequests,
        success: successRequests
      },
      latency: {
        mean: result.latency.average,
        min: result.latency.min,
        max: result.latency.max,
        p50: result.latency.p50,
        p75: result.latency.p75,
        p90: result.latency.p90,
        p99: result.latency.p99
      },
      errors: {
        rate: totalRequests > 0 
          ? (totalErrors / totalRequests * 100) 
          : 0,
        total: totalErrors,
        networkErrors,
        timeouts,
        httpErrors,
        details: errorDetails
      },
      statusCodes: statusCodes,
      bytes: {
        total: result.throughput.total,
        average: result.throughput.average
      }
    },
    raw: result
  };
}

/**
 * 打印并发测试摘要
 * @param {Object} result - 处理后的结果
 */
function printConcurrencySummary(result) {
  console.log('\n' + chalk.bold('📊 并发测试结果摘要'));
  console.log('─'.repeat(50));
  
  console.log(chalk.cyan('\n吞吐量:'));
  console.log(`  平均 RPS: ${chalk.yellow(result.metrics.throughput.rps.toFixed(2))} req/s`);
  console.log(`  最大 RPS: ${chalk.yellow(result.metrics.throughput.maxRps.toFixed(2))} req/s`);
  console.log(`  总请求数: ${result.metrics.throughput.total}`);
  console.log(`  成功请求: ${result.metrics.throughput.success}`);

  console.log(chalk.cyan('\n响应时间:'));
  console.log(`  平均: ${formatLatency(result.metrics.latency.mean)}`);
  console.log(`  P50:  ${formatLatency(result.metrics.latency.p50)}`);
  console.log(`  P90:  ${formatLatency(result.metrics.latency.p90)}`);
  console.log(`  P99:  ${formatLatency(result.metrics.latency.p99)}`);

  console.log(chalk.cyan('\n错误统计:'));
  const errorRate = result.metrics.errors.rate;
  const errorColor = errorRate === 0 ? 'green' : errorRate < 5 ? 'yellow' : 'red';
  console.log(`  错误率: ${chalk[errorColor](errorRate.toFixed(2) + '%')}`);
  console.log(`  总错误: ${result.metrics.errors.total}`);
  
  if (result.metrics.errors.total > 0) {
    if (result.metrics.errors.networkErrors > 0) {
      console.log(`  网络错误: ${result.metrics.errors.networkErrors}`);
    }
    if (result.metrics.errors.timeouts > 0) {
      console.log(`  超时: ${result.metrics.errors.timeouts}`);
    }
    if (result.metrics.errors.httpErrors > 0) {
      console.log(`  HTTP错误: ${result.metrics.errors.httpErrors}`);
    }
    
    // 打印具体错误详情
    if (result.metrics.errors.details && result.metrics.errors.details.length > 0) {
      console.log(chalk.red('\n  ❌ HTTP错误详情:'));
      for (const detail of result.metrics.errors.details) {
        const categoryColor = detail.category === 'server_error' ? 'red' : 'yellow';
        console.log(`     ${chalk[categoryColor](detail.code)}: ${detail.count} 次`);
      }
    }
  }
  
  console.log('─'.repeat(50));
}

/**
 * 格式化延迟时间
 * @param {number} ms - 毫秒数
 * @returns {string} 格式化后的字符串
 */
function formatLatency(ms) {
  if (ms < 1000) {
    return chalk.green(`${ms.toFixed(2)} ms`);
  } else if (ms < 3000) {
    return chalk.yellow(`${(ms / 1000).toFixed(2)} s`);
  } else {
    return chalk.red(`${(ms / 1000).toFixed(2)} s`);
  }
}

export default {
  runConcurrencyTest
};