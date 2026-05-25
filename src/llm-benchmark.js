/**
 * LLM API 基准测试模块
 * 测试LLM API的Token生成效率、并发能力等性能指标
 */

import chalk from 'chalk';
import ora from 'ora';
import { generateContext, countMessagesTokens, validateContext } from './context-generator.js';
import { createHttpClient, validateParams, tokenSpeedTestRules, normalizeApiUrl, DEFAULT_TIMEOUT } from './http-client.js';

/**
 * 运行LLM基准测试
 * @param {Object} options - 测试选项
 * @returns {Promise<Object>} 测试结果
 */
export async function runLlmBenchmarkTest(options) {
  const {
    inputTokens = 100,
    inputText = null,  // 支持直接传入输入文本
    inputTexts = null,  // 支持传入多个输入文本数组（用于避免缓存命中）
    generateInputText = null,  // 动态生成输入文本的函数（每次请求随机抽取样本）
    maxOutputTokens = 500,
    concurrency = 1,
    concurrencyMode = 'batch',  // 并发模式: 'batch'（批次）或 'pipeline'（流水线）
    samples = 10,
    url,
    apiKey,
    model,
    systemPrompt = null,
    contextRounds = 0,
    warmupRequests = 1,
    sampleCount = 0,  // 选取多少个8k sample组成上下文
    timeout = DEFAULT_TIMEOUT,  // 请求超时时间（毫秒）
    quiet = false  // 静默模式
  } = options;

  // 统一获取 User-Agent
  const userAgent = process.env.USER_AGENT || 'llm-benchmark/1.0.0';

  // 必填参数检查
  if (!url) {
    throw new Error('API URL is required. Set API_BASE_URL in .env or use --url option.');
  }
  
  if (!model) {
    throw new Error('Model is required. Set API_MODEL in .env or use --model option.');
  }

  // 参数验证
  const validation = validateParams(options, tokenSpeedTestRules);
  if (!validation.valid) {
    throw new Error(`参数验证失败: ${validation.errors.join(', ')}`);
  }

  // 规范化URL（用于流式请求的axios调用）
  const normalizedUrl = normalizeApiUrl(url);

  // 创建带重试的HTTP客户端（自动处理URL规范化）
  const httpClient = createHttpClient({
    baseURL: url, // createHttpClient会自动规范化
    timeout: timeout,  // 使用传入的超时参数
    headers: {
      'User-Agent': userAgent,
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
    }
  });

  // 生成上下文 - 支持多种输入方式
  // 1. generateInputText函数：每次请求动态生成输入（随机抽取样本）
  // 2. inputTexts数组：每个请求使用不同的输入（避免缓存命中）
  // 3. inputText：所有请求使用相同输入
  // 4. 自动生成：所有请求使用相同的自动生成上下文
  let useDynamicGeneration = !!generateInputText;
  let contextMessagesList = [];  // 每个请求的消息数组（非动态模式使用）
  let actualTokens = 0;
  
  if (generateInputText) {
    // 动态生成模式：每次请求时生成新的输入
    console.log(chalk.cyan('\n🔧 测试配置:'));
    console.log(`  模型: ${model}`);
    console.log(`  输入模式: 动态生成（每次请求随机抽取样本）`);
    console.log(`  每次抽取样本数: ${sampleCount}`);
    // 预估token数
    try {
      const sampleInput = await generateInputText();
      if (sampleInput) {
        actualTokens = countMessagesTokens([{ role: 'user', content: sampleInput }]);
        console.log(`  预估输入Token数: ${actualTokens}`);
      }
    } catch (e) {
      console.log(`  预估输入Token数: 未知`);
    }
  } else if (inputTexts && inputTexts.length > 0) {
    // 使用传入的多个文本作为输入
    contextMessagesList = inputTexts.map(text => [{ role: 'user', content: text }]);
    actualTokens = countMessagesTokens(contextMessagesList[0]);
    console.log(chalk.cyan('\n🔧 测试配置:'));
    console.log(`  模型: ${model}`);
    console.log(`  输入来源: 用户提供的 ${inputTexts.length} 个不同文本`);
    console.log(`  输入Token数: ${actualTokens} (每个样本)`);
  } else if (inputText) {
    // 使用传入的单个文本作为所有请求的输入
    const messages = [{ role: 'user', content: inputText }];
    actualTokens = countMessagesTokens(messages);
    // 为所有请求生成相同的消息
    for (let i = 0; i < samples; i++) {
      contextMessagesList.push([...messages]);
    }
    console.log(chalk.cyan('\n🔧 测试配置:'));
    console.log(`  模型: ${model}`);
    console.log(`  输入来源: 用户提供的文本`);
    console.log(`  输入字符数: ${inputText.length}`);
    console.log(`  实际输入Token数: ${actualTokens}`);
  } else {
    // 自动生成上下文
    const context = generateContext(inputTokens, {
      systemPrompt,
      contextRounds,
      tokensPerRound: Math.floor(inputTokens / (contextRounds * 2 || 1))
    });
    actualTokens = context.actualTokens;
    // 为所有请求生成相同的消息
    for (let i = 0; i < samples; i++) {
      contextMessagesList.push([...context.messages]);
    }
    
    // 验证上下文
    const contextValidation = validateContext(context.messages, context.actualTokens);
    
    console.log(chalk.cyan('\n🔧 测试配置:'));
    console.log(`  模型: ${model}`);
    console.log(`  目标输入Token数: ${inputTokens}`);
    console.log(`  实际输入Token数: ${actualTokens} (精度: ${contextValidation.accuracy})`);
    if (systemPrompt) {
      console.log(`  系统提示词: ${systemPrompt.substring(0, 50)}...`);
    }
    if (contextRounds > 0) {
      console.log(`  多轮对话: ${contextRounds} 轮`);
    }
  }
  
  console.log(`  最大输出Token数: ${maxOutputTokens}`);
  console.log(`  并发数: ${concurrency}`);
  console.log(`  并发模式: ${concurrencyMode === 'pipeline' ? '流水线' : '批次'}`);
  console.log(`  采样次数: ${samples}`);

  // 预热请求
  if (warmupRequests > 0) {
    const warmupSpinner = ora(`执行 ${warmupRequests} 次预热请求...`).start();
    for (let i = 0; i < warmupRequests; i++) {
      try {
        // 动态生成或使用预设消息
        let warmupMessages;
        if (useDynamicGeneration) {
          const warmupText = await generateInputText();
          warmupMessages = [{ role: 'user', content: warmupText }];
        } else {
          warmupMessages = contextMessagesList[0];
        }
        await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, warmupMessages, maxOutputTokens);
      } catch (error) {
        // 检查是否是HTTP错误（4xx/5xx），如果是则停止测试
        if (error.response && error.response.status >= 400) {
          const statusCode = error.response.status;
          warmupSpinner.fail(`预热失败: API错误 (HTTP ${statusCode})`);
          throw new Error(`预热失败: API返回错误状态码 ${statusCode}，请检查API服务器状态`);
        }
        // 其他错误（如网络错误）忽略
      }
    }
    warmupSpinner.succeed('预热完成');
  }

  // 辅助函数：获取指定请求的消息（支持动态生成）
  const getMessagesForRequest = async (requestIndex) => {
    if (useDynamicGeneration) {
      const text = await generateInputText();
      return [{ role: 'user', content: text }];
    }
    return contextMessagesList[requestIndex % contextMessagesList.length];
  };

  // 执行测试 - 支持batch和pipeline两种并发模式
  const results = [];
  const spinner = ora(`执行Token速度测试 (0/${samples})`).start();

  const testStartTime = Date.now();

  if (concurrency > 1 && concurrencyMode === 'pipeline') {
    // 流水线模式：使用更优雅的并发控制，避免 Promise.race 内存问题
    let completed = 0;
    let nextIndex = 0;
    const activePromises = new Map(); // 使用 Map 存储活跃请求
    
    const runRequest = async (requestIndex) => {
      const requestSendTime = Date.now();
      const messages = await getMessagesForRequest(requestIndex);
      
      try {
        const result = await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, messages, maxOutputTokens);
        completed++;
        spinner.text = `执行Token速度测试 (${completed}/${samples})`;
        
        // 每次请求完成后输出详细信息
        logRequestCompletion(completed, samples, result, false, requestIndex + 1);
        
        return {
          ...result,
          requestIndex,
          requestSendTime,
          responseReceiveTime: Date.now()
        };
      } catch (error) {
        completed++;
        spinner.text = `执行Token速度测试 (${completed}/${samples})`;
        
        // 输出错误信息
        logRequestCompletion(completed, samples, { error: error.message }, true, requestIndex + 1);
        
        return {
          success: false,
          error: error.message,
          requestIndex,
          requestSendTime,
          responseReceiveTime: Date.now()
        };
      }
    };
    
    // 初始启动 concurrency 个请求
    for (let i = 0; i < Math.min(concurrency, samples); i++) {
      const promise = runRequest(i);
      activePromises.set(i, promise);
      nextIndex++;
    }
    
    // 使用迭代方式处理完成的请求，避免 Promise.race 的内存问题
    while (completed < samples) {
      // 等待任意一个活跃请求完成
      const [completedIndex, completedResult] = await Promise.race(
        Array.from(activePromises.entries()).map(([idx, promise]) => 
          promise.then(result => [idx, result])
        )
      );
      
      // 保存结果
      results.push(completedResult);
      
      // 从活跃请求中移除已完成的
      activePromises.delete(completedIndex);
      
      // 如果还有更多请求要发，启动下一个
      if (nextIndex < samples) {
        const newPromise = runRequest(nextIndex);
        activePromises.set(nextIndex, newPromise);
        nextIndex++;
      }
    }
    
  } else if (concurrency > 1) {
    // 批次模式：等待整个批次完成后才开始下一批
    let completed = 0;
    const batches = Math.ceil(samples / concurrency);
    
    for (let batch = 0; batch < batches; batch++) {
      const batchStartIndex = batch * concurrency;
      const batchEndIndex = Math.min(batchStartIndex + concurrency, samples);
      const batchSize = batchEndIndex - batchStartIndex;
      
      const batchPromises = [];
      for (let i = 0; i < batchSize; i++) {
        const currentRequestIndex = batchStartIndex + i;
        const requestSendTime = Date.now();
        
        batchPromises.push(
          (async () => {
            const messages = await getMessagesForRequest(currentRequestIndex);
            try {
              const result = await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, messages, maxOutputTokens);
              completed++;
              spinner.text = `执行Token速度测试 (${completed}/${samples})`;
              
              logRequestCompletion(completed, samples, result, false, currentRequestIndex + 1);
              
              return {
                ...result,
                requestIndex: currentRequestIndex,
                requestSendTime,
                responseReceiveTime: Date.now()
              };
            } catch (error) {
              completed++;
              spinner.text = `执行Token速度测试 (${completed}/${samples})`;
              
              logRequestCompletion(completed, samples, { error: error.message }, true, currentRequestIndex + 1);
              
              return {
                success: false,
                error: error.message,
                requestIndex: currentRequestIndex,
                requestSendTime,
                responseReceiveTime: Date.now()
              };
            }
          })()
        );
      }
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
  } else {
    // 顺序模式：逐个执行，记录时间戳
    for (let i = 0; i < samples; i++) {
      spinner.text = `执行Token速度测试 (${i + 1}/${samples})`;
      const requestSendTime = Date.now();
      const messages = await getMessagesForRequest(i);
      
      try {
        const result = await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, messages, maxOutputTokens);
        
        logRequestCompletion(i + 1, samples, result, false, i + 1);
        
        results.push({
          ...result,
          requestIndex: i,
          requestSendTime,
          responseReceiveTime: Date.now()
        });
      } catch (error) {
        logRequestCompletion(i + 1, samples, { error: error.message }, true, i + 1);
        
        results.push({
          success: false,
          error: error.message,
          requestIndex: i,
          requestSendTime,
          responseReceiveTime: Date.now()
        });
      }
    }
  }

  const totalTime = Date.now() - testStartTime;
  spinner.succeed('Token速度测试完成');

  // 处理结果
  const processedResult = processTokenSpeedResult(results, {
    model,  // 添加模型名称
    url,    // 添加API URL
    inputTokens: actualTokens,  // 使用实际计算的token数
    inputTextUsed: !!(inputText || inputTexts),  // 标记是否使用了输入文本
    maxOutputTokens,
    concurrency,
    concurrencyMode,
    samples,
    totalTime,
    sampleCount,
    uniqueInputs: contextMessagesList.length  // 记录不同输入的数量
  });

  // 打印摘要
  printTokenSpeedSummary(processedResult);

  return processedResult;
}

/**
 * 打印请求完成日志
 * @param {number} current - 当前完成数
 * @param {number} total - 总数
 * @param {Object} result - 请求结果
 * @param {boolean} isError - 是否错误
 * @param {number} requestNum - 请求编号
 */
function logRequestCompletion(current, total, result, isError = false, requestNum) {
  const prefix = chalk.gray(`\n[${current}/${total}] 请求 #${requestNum} ${isError ? '失败' : '完成'}:`);
  console.log(prefix);
  
  if (isError) {
    console.log(chalk.red(`  错误: ${result.error}`));
  } else if (result.success !== false) {
    console.log(`  TPS: ${chalk.green(result.tps.toFixed(2))} tokens/s`);
    console.log(`  TTFT: ${result.ttft ? result.ttft.toFixed(0) + ' ms' : 'N/A'}`);
    console.log(`  输出Token: ${result.outputTokens} tokens`);
    console.log(`  生成时间: ${result.generationTime ? (result.generationTime / 1000).toFixed(2) + ' s' : 'N/A'}`);
    console.log(`  总请求时间: ${result.totalRequestTime} ms`);
  }
}

/**
 * 测量单次请求的Token速度
 * @param {Object} httpClient - Axios 实例
 * @param {string} url - API URL
 * @param {string} userAgent - User-Agent 字符串
 * @param {string} model - 模型名称
 * @param {Array} messages - 消息数组
 * @param {number} maxOutputTokens - 最大输出Token数
 * @returns {Promise<Object>} 测量结果
 */
async function measureTokenSpeed(httpClient, url, userAgent, model, messages, maxOutputTokens) {
  const requestStart = Date.now();
  let firstTokenTime = null;
  let tokens = [];
  let outputText = '';  // 用于回退计算（只包含content，不含reasoning）

  try {
    // 构造请求 - 使用流式响应，使用带重试的 httpClient
    const response = await httpClient.post(url, {
      model: model,
      messages: messages,
      max_tokens: maxOutputTokens,
      stream: true
    }, {
      responseType: 'stream'
    });

    return new Promise((resolve, reject) => {
      let buffer = '';
      let apiUsage = null;  // API返回的usage信息
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta || {};
              
              // 捕获API返回的usage信息（流式响应通常在最后发送）
              if (parsed.usage) {
                apiUsage = parsed.usage;
              }
              
              // 支持标准OpenAI格式和Qwen的reasoning格式
              const content = delta.content || '';
              const reasoning = delta.reasoning || '';
              
              // TTFT只计算实际内容的首个Token，不包含推理过程(reasoning)
              // reasoning是模型的内部思考，用户看不到，所以不应该计入TTFT
              if (content) {
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                }
                tokens.push({
                  time: Date.now(),
                  content: content,
                  type: 'content'
                });
                outputText += content;
              }
              // 推理内容单独处理，不计入TTFT，不计入outputText
              if (reasoning) {
                tokens.push({
                  time: Date.now(),
                  content: reasoning,
                  type: 'reasoning'
                });
              }
            } catch (e) {
              // 记录解析错误但不中断处理
              if (process.env.DEBUG) {
                console.warn(chalk.yellow(`⚠️ 流式数据解析错误: ${e.message}`));
              }
            }
          }
        }
      });

      response.data.on('end', () => {
        const requestEnd = Date.now();
        const totalRequestTime = requestEnd - requestStart;
        const ttft = firstTokenTime ? firstTokenTime - requestStart : null;
        // 优先使用API返回的token数量，回退到tokenizer计算
        const outputTokens = apiUsage?.completion_tokens 
          ?? countMessagesTokens([{ role: 'assistant', content: outputText }]);
        // 输入token优先使用API返回值
        const inputTokensActual = apiUsage?.prompt_tokens 
          ?? countMessagesTokens(messages);
        const generationTime = firstTokenTime ? requestEnd - firstTokenTime : 0;
        const tps = outputTokens > 0 && generationTime > 0
          ? (outputTokens / (generationTime / 1000)).toFixed(2)
          : 0;

        resolve({
          success: true,
          totalRequestTime,
          ttft,
          outputTokens,
          inputTokens: inputTokensActual,
          generationTime,
          tps: parseFloat(tps),
          outputText,
          tokenSource: apiUsage ? 'api' : 'tokenizer'  // 标记token来源
        });
      });

      response.data.on('error', (error) => {
        reject(error);
      });
    });
  } catch (error) {
    // 输出详细错误信息用于调试
    if (error.response) {
      let errorDetail = '';
      try {
        const errorData = error.response.data;
        // 使用 JSON.stringify 的 replacer 参数安全序列化
        errorDetail = JSON.stringify(errorData, (key, value) => {
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            return '[Object]';
          }
          return value;
        }, 2);
      } catch (e) {
        errorDetail = error.message || 'Failed to serialize error data';
      }
      console.log(chalk.red(`\n  详细错误: HTTP ${error.response.status}`));
      console.log(chalk.red(`  响应数据: ${errorDetail.substring(0, 500)}`));
    }
    // 如果流式请求失败，直接抛出错误
    throw error;
  }
}

/**
 * 处理Token速度测试结果
 * @param {Array} results - 原始结果数组
 * @param {Object} config - 测试配置
 * @returns {Object} 处理后的结果
 */
function processTokenSpeedResult(results, config) {
  const successResults = results.filter(r => r.success);
  const failedResults = results.filter(r => !r.success);

  if (successResults.length === 0) {
    return {
      type: 'token-speed',
      timestamp: new Date().toISOString(),
      config,
      success: false,
      error: 'All requests failed',
      failedCount: failedResults.length
    };
  }

  const tpsValues = successResults.map(r => r.tps);
  const ttftValues = successResults.map(r => r.ttft).filter(v => v !== null);
  const outputTokensValues = successResults.map(r => r.outputTokens);
  const requestTimeValues = successResults.map(r => r.totalRequestTime);

  // 计算整体吞吐量TPS = 总输出tokens / 总测试时间(秒)
  const totalOutputTokens = outputTokensValues.reduce((a, b) => a + b, 0);
  const totalTimeSeconds = config.totalTime / 1000;
  const throughputTps = totalTimeSeconds > 0 ? totalOutputTokens / totalTimeSeconds : 0;

  return {
    type: 'token-speed',
    timestamp: new Date().toISOString(),
    config,
    success: true,
    metrics: {
      tps: {
        mean: average(tpsValues),
        min: Math.min(...tpsValues),
        max: Math.max(...tpsValues),
        median: median(tpsValues),
        values: tpsValues
      },
      throughputTps,  // 整体吞吐量TPS
      ttft: {
        mean: average(ttftValues),
        min: Math.min(...ttftValues),
        max: Math.max(...ttftValues),
        median: median(ttftValues),
        values: ttftValues
      },
      outputTokens: {
        mean: average(outputTokensValues),
        min: Math.min(...outputTokensValues),
        max: Math.max(...outputTokensValues),
        median: median(outputTokensValues)
      },
      requestTime: {
        mean: average(requestTimeValues),
        min: Math.min(...requestTimeValues),
        max: Math.max(...requestTimeValues),
        median: median(requestTimeValues)
      }
    },
    errors: {
      total: failedResults.length,
      rate: (failedResults.length / results.length * 100).toFixed(2),
      details: failedResults.map(r => ({
        requestIndex: r.requestIndex,
        error: r.error
      }))
    },
    raw: successResults,
    failed: failedResults  // 保存失败请求的原始数据
  };
}

/**
 * 计算平均值
 * @param {Array} arr - 数值数组
 * @returns {number} 平均值
 */
function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 计算中位数
 * @param {Array} arr - 数值数组
 * @returns {number} 中位数
 */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 打印Token速度测试摘要
 * @param {Object} result - 处理后的结果
 */
function printTokenSpeedSummary(result) {
  console.log('\n' + chalk.bold('📊 Token速度测试结果摘要'));
  console.log('─'.repeat(50));

  if (!result.success) {
    console.log(chalk.red('❌ 测试失败:'), result.error);
    return;
  }

  console.log(chalk.cyan('\nToken生成速度 (TPS):'));
  console.log(`  平均: ${formatTps(result.metrics.tps.mean)}`);
  console.log(`  中位数: ${formatTps(result.metrics.tps.median)}`);
  console.log(`  最小: ${formatTps(result.metrics.tps.min)}`);
  console.log(`  最大: ${formatTps(result.metrics.tps.max)}`);
  console.log(`  整体吞吐: ${formatTps(result.metrics.throughputTps)} (总输出tokens / 总测试时间)`);

  console.log(chalk.cyan('\n首Token延迟 (TTFT):'));
  console.log(`  平均: ${formatLatency(result.metrics.ttft.mean)}`);
  console.log(`  中位数: ${formatLatency(result.metrics.ttft.median)}`);
  console.log(`  最小: ${formatLatency(result.metrics.ttft.min)}`);
  console.log(`  最大: ${formatLatency(result.metrics.ttft.max)}`);

  console.log(chalk.cyan('\n输出Token数:'));
  console.log(`  平均: ${result.metrics.outputTokens.mean.toFixed(0)} tokens`);
  console.log(`  中位数: ${result.metrics.outputTokens.median.toFixed(0)} tokens`);

  console.log(chalk.cyan('\n请求时间:'));
  console.log(`  平均: ${formatLatency(result.metrics.requestTime.mean)}`);
  console.log(`  中位数: ${formatLatency(result.metrics.requestTime.median)}`);

  console.log(chalk.cyan('\n错误统计:'));
  const errorRate = parseFloat(result.errors.rate);
  const errorColor = errorRate < 1 ? 'green' : errorRate < 5 ? 'yellow' : 'red';
  console.log(`  错误率: ${chalk[errorColor](errorRate + '%')}`);
  console.log(`  总错误: ${result.errors.total}/${result.config.samples}`);
  console.log('─'.repeat(50));
}

/**
 * 格式化TPS
 * @param {number} tps - Token每秒
 * @returns {string} 格式化后的字符串
 */
function formatTps(tps) {
  if (tps >= 50) {
    return chalk.green(`${tps.toFixed(2)} tokens/s`);
  } else if (tps >= 20) {
    return chalk.yellow(`${tps.toFixed(2)} tokens/s`);
  } else {
    return chalk.red(`${tps.toFixed(2)} tokens/s`);
  }
}

/**
 * 格式化延迟时间
 * @param {number} ms - 毫秒数
 * @returns {string} 格式化后的字符串
 */
function formatLatency(ms) {
  if (ms < 500) {
    return chalk.green(`${ms.toFixed(0)} ms`);
  } else if (ms < 2000) {
    return chalk.yellow(`${ms.toFixed(0)} ms`);
  } else {
    return chalk.red(`${(ms / 1000).toFixed(2)} s`);
  }
}

export default {
  runLlmBenchmarkTest
};