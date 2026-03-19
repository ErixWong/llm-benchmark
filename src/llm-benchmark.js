/**
 * LLM API 基准测试模块
 * 测试LLM API的Token生成效率、并发能力等性能指标
 */

import axios from 'axios';
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
    model = 'gpt-3.5-turbo',
    systemPrompt = null,
    contextRounds = 0,
    warmupRequests = 1,
    sampleCount = 0,  // 选取多少个8k sample组成上下文
    timeout = DEFAULT_TIMEOUT  // 请求超时时间（毫秒）
  } = options;

  // 参数验证
  const validation = validateParams(options, tokenSpeedTestRules);
  if (!validation.valid) {
    throw new Error(`参数验证失败: ${validation.errors.join(', ')}`);
  }

  if (!url) {
    throw new Error('API URL is required. Set API_BASE_URL in .env or use --url option.');
  }

  // 规范化URL（用于流式请求的axios调用）
  const normalizedUrl = normalizeApiUrl(url);

  // 创建带重试的HTTP客户端（自动处理URL规范化）
  const httpClient = createHttpClient({
    baseURL: url, // createHttpClient会自动规范化
    timeout: DEFAULT_TIMEOUT,  // 使用环境变量配置
    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
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
        await measureTokenSpeed(normalizedUrl, apiKey, model, warmupMessages, maxOutputTokens, timeout);
      } catch (error) {
        // 忽略预热错误
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
    // 流水线模式：一个请求完成后立即开始下一个
    let completed = 0;
    let nextIndex = 0;
    const activeRequests = new Set();
    
    const runRequest = async (requestIndex) => {
      const requestSendTime = Date.now();
      const messages = await getMessagesForRequest(requestIndex);
      
      try {
        const result = await measureTokenSpeed(normalizedUrl, apiKey, model, messages, maxOutputTokens, timeout);
        completed++;
        spinner.text = `执行Token速度测试 (${completed}/${samples})`;
        
        // 每次请求完成后输出详细信息
        console.log(chalk.gray(`\n[${completed}/${samples}] 请求 #${requestIndex + 1} 完成:`));
        if (result.success !== false) {
          console.log(`  TPS: ${chalk.green(result.tps.toFixed(2))} tokens/s`);
          console.log(`  TTFT: ${result.ttft ? result.ttft.toFixed(0) + ' ms' : 'N/A'}`);
          console.log(`  输出Token: ${result.outputTokens} tokens`);
          console.log(`  生成时间: ${result.generationTime ? (result.generationTime / 1000).toFixed(2) + ' s' : 'N/A'}`);
          console.log(`  总请求时间: ${result.totalRequestTime} ms`);
        }
        
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
        console.log(chalk.gray(`\n[${completed}/${samples}] 请求 #${requestIndex + 1} 失败:`));
        console.log(chalk.red(`  错误: ${error.message}`));
        
        return {
          success: false,
          error: error.message,
          requestIndex,
          requestSendTime,
          responseReceiveTime: Date.now()
        };
      }
    };
    
    // 初始启动concurrency个请求
    const initialPromises = [];
    for (let i = 0; i < Math.min(concurrency, samples); i++) {
      activeRequests.add(i);
      initialPromises.push(
        runRequest(i).then(result => {
          activeRequests.delete(i);
          return result;
        })
      );
    }
    nextIndex = Math.min(concurrency, samples);
    
    // 等待所有请求完成，每完成一个就启动下一个
    const pendingPromises = [...initialPromises];
    
    while (completed < samples) {
      // 使用Promise.race等待任意一个完成
      const completedPromise = await Promise.race(
        pendingPromises.map(p => p.then(result => ({ result, promise: p })))
      );
      
      results.push(completedPromise.result);
      
      // 从pending中移除已完成的
      const idx = pendingPromises.indexOf(completedPromise.promise);
      if (idx > -1) {
        pendingPromises.splice(idx, 1);
      }
      
      // 如果还有更多请求要发，启动下一个
      if (nextIndex < samples) {
        const newIndex = nextIndex++;
        activeRequests.add(newIndex);
        const newPromise = runRequest(newIndex).then(result => {
          activeRequests.delete(newIndex);
          return result;
        });
        pendingPromises.push(newPromise);
      }
    }
    
    // 等待所有剩余的promise完成
    const remainingResults = await Promise.all(pendingPromises);
    results.push(...remainingResults);
    
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
              const result = await measureTokenSpeed(normalizedUrl, apiKey, model, messages, maxOutputTokens, timeout);
              completed++;
              spinner.text = `执行Token速度测试 (${completed}/${samples})`;
              
              // 每次请求完成后输出详细信息
              console.log(chalk.gray(`\n[${completed}/${samples}] 请求 #${currentRequestIndex + 1} 完成:`));
              if (result.success !== false) {
                console.log(`  TPS: ${chalk.green(result.tps.toFixed(2))} tokens/s`);
                console.log(`  TTFT: ${result.ttft ? result.ttft.toFixed(0) + ' ms' : 'N/A'}`);
                console.log(`  输出Token: ${result.outputTokens} tokens`);
                console.log(`  生成时间: ${result.generationTime ? (result.generationTime / 1000).toFixed(2) + ' s' : 'N/A'}`);
                console.log(`  总请求时间: ${result.totalRequestTime} ms`);
              }
              
              return {
                ...result,
                requestIndex: currentRequestIndex,
                requestSendTime,
                responseReceiveTime: Date.now()
              };
            } catch (error) {
              completed++;
              spinner.text = `执行Token速度测试 (${completed}/${samples})`;
              
              // 输出错误信息
              console.log(chalk.gray(`\n[${completed}/${samples}] 请求 #${currentRequestIndex + 1} 失败:`));
              console.log(chalk.red(`  错误: ${error.message}`));
              
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
        const result = await measureTokenSpeed(normalizedUrl, apiKey, model, messages, maxOutputTokens, timeout);
        
        // 每次请求完成后输出详细信息
        console.log(chalk.gray(`\n[${i + 1}/${samples}] 请求 #${i + 1} 完成:`));
        if (result.success !== false) {
          console.log(`  TPS: ${chalk.green(result.tps.toFixed(2))} tokens/s`);
          console.log(`  TTFT: ${result.ttft ? result.ttft.toFixed(0) + ' ms' : 'N/A'}`);
          console.log(`  输出Token: ${result.outputTokens} tokens`);
          console.log(`  生成时间: ${result.generationTime ? (result.generationTime / 1000).toFixed(2) + ' s' : 'N/A'}`);
          console.log(`  总请求时间: ${result.totalRequestTime} ms`);
        }
        
        results.push({
          ...result,
          requestIndex: i,
          requestSendTime,
          responseReceiveTime: Date.now()
        });
      } catch (error) {
        // 输出错误信息
        console.log(chalk.gray(`\n[${i + 1}/${samples}] 请求 #${i + 1} 失败:`));
        console.log(chalk.red(`  错误: ${error.message}`));
        
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
 * 测量单次请求的Token速度
 * @param {string} url - API URL
 * @param {string} apiKey - API密钥
 * @param {string} model - 模型名称
 * @param {Array} messages - 消息数组
 * @param {number} maxOutputTokens - 最大输出Token数
 * @returns {Promise<Object>} 测量结果
 */
async function measureTokenSpeed(url, apiKey, model, messages, maxOutputTokens, timeout = DEFAULT_TIMEOUT) {
  const requestStart = Date.now();
  let firstTokenTime = null;
  let tokens = [];
  let outputText = '';

  // 构建请求头，仅在apiKey存在时添加Authorization
  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    // 构造请求 - 使用流式响应
    const response = await axios({
      method: 'POST',
      url: url,
      headers,
      data: {
        model: model,
        messages: messages,
        max_tokens: maxOutputTokens,
        stream: true
      },
      responseType: 'stream',
      timeout: timeout  // 使用传入的超时参数
    });

    return new Promise((resolve, reject) => {
      let buffer = '';
      
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
              
              // 支持标准OpenAI格式和Qwen的reasoning格式
              const content = delta.content || delta.reasoning || '';
              
              if (content) {
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                }
                tokens.push({
                  time: Date.now(),
                  content: content
                });
                outputText += content;
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      });

      response.data.on('end', () => {
        const requestEnd = Date.now();
        const totalRequestTime = requestEnd - requestStart;
        const ttft = firstTokenTime ? firstTokenTime - requestStart : null;
        // 使用tokenizer精确计算输出token数量
        const outputTokens = countMessagesTokens([{ role: 'assistant', content: outputText }]);
        const generationTime = firstTokenTime ? requestEnd - firstTokenTime : 0;
        const tps = outputTokens > 0 && generationTime > 0 
          ? (outputTokens / (generationTime / 1000)).toFixed(2) 
          : 0;

        resolve({
          success: true,
          totalRequestTime,
          ttft,
          outputTokens,
          generationTime,
          tps: parseFloat(tps),
          outputText
        });
      });

      response.data.on('error', (error) => {
        reject(error);
      });
    });
  } catch (error) {
    // 如果流式请求失败，尝试非流式请求
    return await measureTokenSpeedNonStreaming(url, apiKey, model, messages, maxOutputTokens, timeout);
  }
}

/**
 * 非流式请求测量Token速度
 * @param {string} url - API URL
 * @param {string} apiKey - API密钥
 * @param {string} model - 模型名称
 * @param {Array} messages - 消息数组
 * @param {number} maxOutputTokens - 最大输出Token数
 * @returns {Promise<Object>} 测量结果
 */
async function measureTokenSpeedNonStreaming(url, apiKey, model, messages, maxOutputTokens, timeout = DEFAULT_TIMEOUT) {
  const requestStart = Date.now();

  // 构建请求头，仅在apiKey存在时添加Authorization
  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const response = await axios({
    method: 'POST',
    url: url,
    headers,
    data: {
      model: model,
      messages: messages,
      max_tokens: maxOutputTokens,
      stream: false
    },
    timeout: timeout  // 使用传入的超时参数
  });

  const requestEnd = Date.now();
  const totalRequestTime = requestEnd - requestStart;
  
  // 从响应中获取Token信息
  const usage = response.data.usage || {};
  const outputContent = response.data.choices?.[0]?.message?.content || '';
  const outputTokens = usage.completion_tokens || countMessagesTokens([{ role: 'assistant', content: outputContent }]);
  const inputTokensActual = usage.prompt_tokens || countMessagesTokens(messages);

  // 估算TPS (假设TTFT约为总时间的10%)
  const estimatedTTFT = totalRequestTime * 0.1;
  const generationTime = totalRequestTime - estimatedTTFT;
  const tps = outputTokens > 0 && generationTime > 0 
    ? (outputTokens / (generationTime / 1000)).toFixed(2) 
    : 0;

  return {
    success: true,
    totalRequestTime,
    ttft: estimatedTTFT,
    outputTokens,
    generationTime,
    tps: parseFloat(tps),
    inputTokens: inputTokensActual,
    outputText: outputContent
  };
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
      rate: (failedResults.length / results.length * 100).toFixed(2)
    },
    raw: successResults
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