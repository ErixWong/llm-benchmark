/**
 * LLM API 基准测试模块
 * 测试LLM API的Token生成效率、并发能力等性能指标
 */

import chalk from 'chalk';
import ora from 'ora';
import { randomUUID } from 'node:crypto';
import { generateContext, countMessagesTokens, validateContext } from './context-generator.js';
import { createHttpClient, validateParams, tokenSpeedTestRules, normalizeApiUrl, getDefaultTimeout } from './http-client.js';
import { computeTokenStats } from './token-stats.js';
import { computeDecodeStats } from './decode-stats.js';
import { sanitizeExtraBody } from './extra-body.js';
import {
  extractCacheUsage,
  summarizeCache,
  summarizeDiagnostics,
  shouldWarnAboutTps,
  shouldCollapseTpsStatistics
} from './cache-stats.js';

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
    generateInputText = null,  // 动态生成输入文本的函数（按请求序号确定性选择样本）
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
    sampleSeed = 42,
    sampleFiles = [],
    sampleSelections = [],
    bank = null,
    bankItemIds = [],
    timeout = getDefaultTimeout(),  // 请求超时时间（毫秒）
    extraBody = null,  // 附加请求体参数（如 chat_template_kwargs）
    quiet = false,  // 静默模式
    requestPlan = null,
    cacheProbe = null,
    warmupMode = 'auto',
    cacheSeed,
    prefixTokens,
    runSalt,
    retry = 3
  } = options;

  if (cacheProbe && (cacheProbe.warmupMode === 'none' || warmupMode === 'none')) {
    throw new Error('缓存探针必须预热前缀，请使用默认 prefix 或 model');
  }

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
    retryConfig: { maxRetries: retry },
    headers: {
      'User-Agent': userAgent,
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
    }
  });

  // 生成上下文 - 支持多种输入方式
  // 1. generateInputText函数：按请求序号动态生成输入
  // 2. inputTexts数组：每个请求使用不同的输入（避免缓存命中）
  // 3. inputText：所有请求使用相同输入
  // 4. 自动生成：所有请求使用相同的自动生成上下文
  const useDynamicGeneration = !requestPlan && !!generateInputText;
  let contextMessagesList = [];  // 每个请求的消息数组（非动态模式使用）
  let actualTokens = 0;
  
  if (requestPlan) {
    if (requestPlan.length !== samples) {
      throw new Error(`requestPlan 长度 (${requestPlan.length}) 必须等于计时请求数 (${samples})`);
    }
    const firstText = requestPlan[0]?.text ?? '';
    actualTokens = countMessagesTokens([{ role: 'user', content: firstText }]);
    console.log(chalk.cyan('\n🔧 测试配置:'));
    console.log(`  模型: ${model}`);
    console.log(`  输入来源: 缓存探针请求计划 (${requestPlan.length} 个请求)`);
    console.log(`  输入Token数: ${actualTokens} (首个请求)`);
  } else if (generateInputText) {
    // 动态生成模式：每次请求时生成新的输入
    console.log(chalk.cyan('\n🔧 测试配置:'));
    console.log(`  模型: ${model}`);
    console.log(`  输入模式: 动态生成（按请求序号选择输入）`);
    console.log(`  每次抽取样本数: ${sampleCount}`);
    // 预估token数
    try {
      const sampleInput = await generateInputText(0);
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

  // 探针预热按单元串行执行，确保计时请求开始前所有待测前缀已预置。
  if (cacheProbe) {
    const mode = cacheProbe.warmupMode === 'auto' ? 'prefix' : cacheProbe.warmupMode;
    if (mode === 'model') {
      const modelWarmupText = `[c-model-warmup-${randomUUID()}] 请回复 ok`;
      await measureTokenSpeed(
        httpClient,
        normalizedUrl,
        userAgent,
        model,
        [{ role: 'user', content: modelWarmupText }],
        1,
        extraBody
      );
      console.log(chalk.gray('模型/JIT 预热完成，开始缓存前缀预热'));
    } else if (mode !== 'prefix') {
      throw new Error(`无效的缓存探针预热模式: ${mode}`);
    }

    const warmupSpinner = ora(`执行缓存前缀预热 (0/${cacheProbe.units.length})...`).start();
    for (let i = 0; i < cacheProbe.units.length; i++) {
      warmupSpinner.text = `执行缓存前缀预热 (${i + 1}/${cacheProbe.units.length})...`;
      try {
        const result = await measureTokenSpeed(
          httpClient,
          normalizedUrl,
          userAgent,
          model,
          [{ role: 'user', content: cacheProbe.units[i].primed }],
          1,
          extraBody
        );
        if (!result.success) {
          throw new Error(`缓存前缀预热请求 #${i + 1} 未成功`);
        }
      } catch (error) {
        warmupSpinner.fail(`缓存前缀预热失败 (${i + 1}/${cacheProbe.units.length})`);
        throw error;
      }
    }
    warmupSpinner.succeed('缓存前缀预热完成');
  } else if (warmupMode === 'prefix') {
    throw new Error('warmup-mode prefix 需要启用 --cache-probe');
  } else if (warmupMode === 'model') {
    const modelWarmupText = `[c-model-warmup-${randomUUID()}] 请回复 ok`;
    await measureTokenSpeed(
      httpClient,
      normalizedUrl,
      userAgent,
      model,
      [{ role: 'user', content: modelWarmupText }],
      1,
      extraBody
    );
    console.log(chalk.gray('模型/JIT 预热完成'));
  } else if (warmupMode === 'none') {
    // 显式跳过预热请求。
  } else if (warmupMode === 'auto' && warmupRequests > 0) {
    const warmupSpinner = ora(`执行 ${warmupRequests} 次预热请求...`).start();
    for (let i = 0; i < warmupRequests; i++) {
      try {
        // 动态生成或使用预设消息
        let warmupMessages;
        if (useDynamicGeneration) {
          const warmupText = await generateInputText(0);
          warmupMessages = [{ role: 'user', content: warmupText }];
        } else {
          warmupMessages = contextMessagesList[0];
        }
        await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, warmupMessages, maxOutputTokens, extraBody);
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
    if (requestPlan) {
      const plannedRequest = requestPlan[requestIndex];
      if (!plannedRequest) {
        throw new Error(`requestPlan 缺少第 ${requestIndex + 1} 条计时请求`);
      }
      return {
        messages: [{ role: 'user', content: plannedRequest.text }],
        intent: plannedRequest.intent,
        unitIndex: plannedRequest.unitIndex
      };
    }
    if (useDynamicGeneration) {
      const text = await generateInputText(requestIndex);
      return {
        messages: [{ role: 'user', content: text }],
        intent: undefined,
        unitIndex: undefined,
        bankItemId: bankItemIds[requestIndex]
      };
    }
    return {
      messages: contextMessagesList[requestIndex % contextMessagesList.length],
      intent: undefined,
      unitIndex: undefined
    };
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
      const { messages, intent, unitIndex, bankItemId } = await getMessagesForRequest(requestIndex);
      
      try {
        const result = await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, messages, maxOutputTokens, extraBody);
        completed++;
        spinner.text = `执行Token速度测试 (${completed}/${samples})`;
        
        // 每次请求完成后输出详细信息
        logRequestCompletion(completed, samples, result, false, requestIndex + 1);
        
        return {
          ...result,
          requestIndex,
          requestSendTime,
          responseReceiveTime: Date.now(),
          ...(bankItemId ? { bankItemId } : {}),
          ...(intent ? { cacheIntent: intent, cacheUnitIndex: unitIndex } : {})
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
          responseReceiveTime: Date.now(),
          ...(bankItemId ? { bankItemId } : {}),
          ...(intent ? { cacheIntent: intent, cacheUnitIndex: unitIndex } : {})
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
            const { messages, intent, unitIndex, bankItemId } = await getMessagesForRequest(currentRequestIndex);
            try {
              const result = await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, messages, maxOutputTokens, extraBody);
              completed++;
              spinner.text = `执行Token速度测试 (${completed}/${samples})`;
              
              logRequestCompletion(completed, samples, result, false, currentRequestIndex + 1);
              
              return {
                ...result,
                requestIndex: currentRequestIndex,
                requestSendTime,
                responseReceiveTime: Date.now(),
                ...(bankItemId ? { bankItemId } : {}),
                ...(intent ? { cacheIntent: intent, cacheUnitIndex: unitIndex } : {})
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
                responseReceiveTime: Date.now(),
                ...(bankItemId ? { bankItemId } : {}),
                ...(intent ? { cacheIntent: intent, cacheUnitIndex: unitIndex } : {})
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
      const { messages, intent, unitIndex, bankItemId } = await getMessagesForRequest(i);
      
      try {
        const result = await measureTokenSpeed(httpClient, normalizedUrl, userAgent, model, messages, maxOutputTokens, extraBody);
        
        logRequestCompletion(i + 1, samples, result, false, i + 1);
        
        results.push({
          ...result,
          requestIndex: i,
          requestSendTime,
          responseReceiveTime: Date.now(),
          ...(bankItemId ? { bankItemId } : {}),
          ...(intent ? { cacheIntent: intent, cacheUnitIndex: unitIndex } : {})
        });
      } catch (error) {
        logRequestCompletion(i + 1, samples, { error: error.message }, true, i + 1);
        
        results.push({
          success: false,
          error: error.message,
          requestIndex: i,
          requestSendTime,
          responseReceiveTime: Date.now(),
          ...(bankItemId ? { bankItemId } : {}),
          ...(intent ? { cacheIntent: intent, cacheUnitIndex: unitIndex } : {})
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
    inputTextUsed: !!(inputText || inputTexts || requestPlan || bank),  // 标记是否使用了输入文本
    maxOutputTokens,
    concurrency,
    concurrencyMode,
    samples,
    totalTime,
    timeout,
    extraBody: sanitizeExtraBody(extraBody).body,
    sampleCount,
    ...(!cacheProbe && sampleCount > 0 ? {
      sampleSeed,
      sampleFiles,
      sampleSelections
    } : {}),
    ...(!cacheProbe && bank ? { bank } : {}),
    uniqueInputs: requestPlan
      ? new Set(requestPlan.map(request => request.text)).size
      : contextMessagesList.length,  // 记录不同输入的数量
    ...(cacheProbe ? {
      cacheProbe: true,
      warmupMode: cacheProbe.warmupMode,
      cacheSeed,
      runSalt,
      prefixTokens,
      suffix: cacheProbe.suffix,
      order: cacheProbe.order,
      ...(cacheProbe.bank ? { bank: cacheProbe.bank } : {}),
      units: cacheProbe.units.map(unit => ({
        unitIndex: unit.unitIndex,
        itemId: unit.itemId,
        prefixHash: unit.prefixHash,
        prefixTokens: unit.prefixTokens
      })),
      prefixValidation: cacheProbe.prefixValidation
    } : {}),
    ...(!cacheProbe && warmupMode !== 'auto' ? { warmupMode } : {}),
    ...(cacheProbe || retry !== 3 ? { retry } : {})
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
    console.log(`  TTFT: ${result.ttft != null ? result.ttft.toFixed(0) + ' ms' : 'N/A'}`);
    if (result.ttfo != null) {
      console.log(`  TTFO (首个可见内容): ${result.ttfo.toFixed(0)} ms`);
    }
    const sourceLabel = result.tokenSource === 'api' ? 'api' : 'client';
    console.log(`  输出Token: ${result.outputTokens} tokens${result.reasoningTokens ? chalk.gray(` (推理 ${result.reasoningTokens} / 内容 ${result.contentTokens})`) : ''} ${chalk.gray(`[${sourceLabel}]`)}`);
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
async function measureTokenSpeed(httpClient, url, userAgent, model, messages, maxOutputTokens, extraBody = null) {
  const requestStart = Date.now();
  let firstTokenTime = null;       // 首个生成 token（含 reasoning），用于 TTFT / TPS
  let firstOutputTime = null;      // 首个可见 content token，用于 TTFO
  let outputText = '';             // 可见内容（content）
  let reasoningText = '';          // 推理内容（reasoning）

  try {
    // 构造请求 - 使用流式响应，使用带重试的 httpClient
    // 显式请求 usage：vLLM / OpenAI 兼容服务端在流式模式下默认不返回 usage，
    // 不请求的话所有 token 数都会退化成客户端 tokenizer 估算。
    const { body: extra } = sanitizeExtraBody(extraBody);
    const streamOptions = { include_usage: true, ...(extra.stream_options || {}) };
    const response = await httpClient.post(url, {
      model: model,
      messages: messages,
      max_tokens: maxOutputTokens,
      stream: true,
      ...extra,
      stream_options: streamOptions
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
              
              // 支持标准OpenAI格式、Qwen/GLM 的 reasoning 格式
              const content = delta.content || '';
              const reasoning = delta.reasoning || delta.reasoning_content || '';
              const now = Date.now();

              // 首个 token（无论是 reasoning 还是 content）决定真正的 TTFT：
              // 对推理模型而言，reasoning 也是模型实际生成的 token，
              // 因此计入 TTFT 与 TPS 才能正确衡量其生成速度。
              if (content) {
                if (!firstTokenTime) {
                  firstTokenTime = now;
                }
                if (!firstOutputTime) {
                  firstOutputTime = now;
                }
                outputText += content;
              }
              if (reasoning) {
                if (!firstTokenTime) {
                  firstTokenTime = now;
                }
                reasoningText += reasoning;
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
        // TTFT：首个生成 token（reasoning 或 content）到达时间
        const ttft = firstTokenTime ? firstTokenTime - requestStart : null;
        // TTFO：首个可见 content token（非 reasoning）到达时间
        const ttfo = firstOutputTime ? firstOutputTime - requestStart : null;
        // token 统计：有 usage 用服务端口径，否则客户端 tokenizer 独立估算（不做跨源相减）
        const { outputTokens, contentTokens, reasoningTokens, tokenSource, reasoningTokenSource } =
          computeTokenStats({ outputText, reasoningText, apiUsage });
        // 缓存命中率只使用服务端 prompt_tokens；inputTokens 仍保留客户端回退。
        const promptTokens = typeof apiUsage?.prompt_tokens === 'number'
          ? apiUsage.prompt_tokens
          : null;
        const { cachedPromptTokens, source: cacheSource } = extractCacheUsage(apiUsage, promptTokens);
        const inputTokens = promptTokens ?? countMessagesTokens(messages);
        const generationTime = firstTokenTime ? requestEnd - firstTokenTime : 0;
        const tps = outputTokens > 0 && generationTime > 0
          ? (outputTokens / (generationTime / 1000)).toFixed(2)
          : 0;

        resolve({
          success: true,
          maxOutputTokens,
          totalRequestTime,
          ttft,
          ttfo,
          outputTokens,
          reasoningTokens,
          contentTokens,
          inputTokens,
          promptTokens,
          cachedPromptTokens,
          cacheSource,
          hasUsage: apiUsage !== null,
          retries: response.config?.__retryCount ?? 0,
          generationTime,
          tps: parseFloat(tps),
          outputText,
          reasoningText,
          tokenSource,           // 输出 token 来源: api | tokenizer
          reasoningTokenSource   // 推理 token 来源: api | tokenizer
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
  const diagnostics = summarizeDiagnostics(successResults);
  const decodeStats = computeDecodeStats(successResults, config.totalTime);

  if (successResults.length === 0) {
    return {
      type: 'token-speed',
      timestamp: new Date().toISOString(),
      config,
      success: false,
      error: 'All requests failed',
      failedCount: failedResults.length,
      metrics: {
        diagnostics,
        decodeThroughputTps: decodeStats.decodeThroughputTps,
        effectiveDecodeConcurrency: decodeStats.effectiveDecodeConcurrency,
        ...(config.cacheProbe ? { cache: summarizeCache(successResults) } : {})
      }
    };
  }

  const tpsValues = successResults.map(r => r.tps);
  const ttftValues = successResults.map(r => r.ttft).filter(v => v !== null);
  const ttfoValues = successResults.map(r => r.ttfo).filter(v => v != null);
  const outputTokensValues = successResults.map(r => r.outputTokens);
  const reasoningTokensValues = successResults.map(r => r.reasoningTokens || 0);
  const contentTokensValues = successResults.map(r => r.contentTokens || 0);
  const requestTimeValues = successResults.map(r => r.totalRequestTime);

  // 计算整体吞吐量TPS = 总输出tokens / 总测试时间(秒)
  const totalOutputTokens = outputTokensValues.reduce((a, b) => a + b, 0);
  const totalTimeSeconds = config.totalTime / 1000;
  const throughputTps = totalTimeSeconds > 0 ? totalOutputTokens / totalTimeSeconds : 0;
  // token 计数来源分布（无 usage 时全部为客户端 tokenizer 估算）
  const apiTokenRequests = successResults.filter(r => r.tokenSource === 'api').length;

  return {
    type: 'token-speed',
    timestamp: new Date().toISOString(),
    config,
    success: true,
    metrics: {
      tps: {
        mean: average(tpsValues),
        min: safeMin(tpsValues),
        max: safeMax(tpsValues),
        median: median(tpsValues),
        values: tpsValues
      },
      throughputTps,        // 端到端墙钟吞吐 = 总输出tokens / 总测试时间（与 vLLM/AIPerf 口径一致）
      decodeThroughputTps: decodeStats.decodeThroughputTps,
      effectiveDecodeConcurrency: decodeStats.effectiveDecodeConcurrency,
      ttft: {
        mean: average(ttftValues),
        min: safeMin(ttftValues),
        max: safeMax(ttftValues),
        median: median(ttftValues),
        values: ttftValues
      },
      ttfo: {
        mean: average(ttfoValues),
        min: safeMin(ttfoValues),
        max: safeMax(ttfoValues),
        median: median(ttfoValues),
        values: ttfoValues
      },
      outputTokens: {
        mean: average(outputTokensValues),
        min: safeMin(outputTokensValues),
        max: safeMax(outputTokensValues),
        median: median(outputTokensValues)
      },
      reasoningTokens: {
        mean: average(reasoningTokensValues),
        total: reasoningTokensValues.reduce((a, b) => a + b, 0),
        values: reasoningTokensValues
      },
      contentTokens: {
        mean: average(contentTokensValues),
        total: contentTokensValues.reduce((a, b) => a + b, 0),
        values: contentTokensValues
      },
      tokenSource: {
        api: apiTokenRequests,
        tokenizer: successResults.length - apiTokenRequests
      },
      diagnostics,
      requestTime: {
        mean: average(requestTimeValues),
        min: safeMin(requestTimeValues),
        max: safeMax(requestTimeValues),
        median: median(requestTimeValues)
      },
      ...(config.cacheProbe ? { cache: summarizeCache(successResults) } : {})
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
 * 安全最小值（空数组返回0）
 * @param {Array} arr - 数值数组
 * @returns {number}
 */
function safeMin(arr) {
  return arr.length === 0 ? 0 : Math.min(...arr);
}

/**
 * 安全最大值（空数组返回0）
 * @param {Array} arr - 数值数组
 * @returns {number}
 */
function safeMax(arr) {
  return arr.length === 0 ? 0 : Math.max(...arr);
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
    if (result.metrics?.cache) {
      printCacheSummary(result.metrics.cache, result.config);
    }
    console.log(chalk.red('❌ 测试失败:'), result.error);
    return;
  }

  console.log(chalk.cyan('\nToken生成速度 (TPS):'));
  const tpsSampleCount = Array.isArray(result.metrics.tps.values)
    ? result.metrics.tps.values.length
    : result.config.samples;
  if (shouldCollapseTpsStatistics(tpsSampleCount)) {
    console.log(`  TPS 统计（样本不足，n=${tpsSampleCount}）: ${formatTpsStatistics(result.metrics.tps)}`);
  } else {
    console.log(`  平均: ${formatTps(result.metrics.tps.mean)}`);
    console.log(`  中位数: ${formatTps(result.metrics.tps.median)}`);
    console.log(`  最小: ${formatTps(result.metrics.tps.min)}`);
    console.log(`  最大: ${formatTps(result.metrics.tps.max)}`);
  }
  if (shouldWarnAboutTps({
    outputTokensMedian: result.metrics.outputTokens.median,
    truncatedRequests: result.metrics.diagnostics?.truncatedRequests
      ?? result.metrics.cache?.truncatedRequests
      ?? 0,
    totalRequests: result.config.samples
  })) {
    console.log(chalk.yellow('  ⚠️ 输出过短，TPS 不具意义'));
  }
  console.log(`  整体吞吐: ${formatTps(result.metrics.throughputTps)} (总输出tokens / 总测试时间，墙钟口径)`);
  const decodeThroughput = result.metrics.decodeThroughputTps;
  console.log(`  解码期聚合吞吐: ${decodeThroughput === null ? 'N/A' : formatTps(decodeThroughput)} (总输出tokens / 解码窗口并集)`);
  const effectiveConcurrency = result.metrics.effectiveDecodeConcurrency;
  console.log(`  有效解码并发度: ${effectiveConcurrency === null ? 'N/A' : effectiveConcurrency.toFixed(2)} (Σ解码时长 / 总测试时间)`);
  console.log(chalk.gray('  关系：throughputTps = 平均单流 TPS × effectiveDecodeConcurrency；TTFT、排队与批次间隙不产 token。'));

  console.log(chalk.cyan('\n首Token延迟:'));
  console.log(`  TTFT (含推理) 平均: ${formatLatency(result.metrics.ttft.mean)}`);
  console.log(`  TTFT (含推理) 中位数: ${formatLatency(result.metrics.ttft.median)}`);
  console.log(`  TTFT (含推理) 最小: ${formatLatency(result.metrics.ttft.min)}`);
  console.log(`  TTFT (含推理) 最大: ${formatLatency(result.metrics.ttft.max)}`);
  if (result.metrics.ttfo?.values?.length > 0) {
    console.log(`  TTFO (首个可见内容) 平均: ${formatLatency(result.metrics.ttfo.mean)}`);
  }
  console.log(chalk.gray('  TTFT 到首个生成 token（含 reasoning）；TTFO 到首个可见内容。'));

  console.log(chalk.cyan('\n输出Token数:'));
  console.log(`  平均: ${result.metrics.outputTokens.mean.toFixed(0)} tokens`);
  console.log(`  中位数: ${result.metrics.outputTokens.median.toFixed(0)} tokens`);
  if (result.metrics.reasoningTokens?.total > 0) {
    console.log(`  推理Token总计: ${result.metrics.reasoningTokens.total} tokens (平均 ${result.metrics.reasoningTokens.mean.toFixed(0)}/请求)`);
    console.log(`  内容Token总计: ${result.metrics.contentTokens.total} tokens (平均 ${result.metrics.contentTokens.mean.toFixed(0)}/请求)`);
  }
  const tokenSourceStats = result.metrics.tokenSource;
  if (tokenSourceStats) {
    console.log(chalk.gray(`  Token来源: 服务端usage ${tokenSourceStats.api} / 客户端估算 ${tokenSourceStats.tokenizer}`));
    if (tokenSourceStats.api === 0) {
      console.log(chalk.gray('  （服务端未返回 usage，绝对 token 数为客户端 tokenizer 估算值）'));
    }
  }

  console.log(chalk.cyan('\n请求时间:'));
  console.log(`  平均: ${formatLatency(result.metrics.requestTime.mean)}`);
  console.log(`  中位数: ${formatLatency(result.metrics.requestTime.median)}`);

  console.log(chalk.cyan('\n错误统计:'));
  const errorRate = parseFloat(result.errors.rate);
  const errorColor = errorRate < 1 ? 'green' : errorRate < 5 ? 'yellow' : 'red';
  console.log(`  错误率: ${chalk[errorColor](errorRate + '%')}`);
  console.log(`  总错误: ${result.errors.total}/${result.config.samples}`);
  if (result.metrics.cache) {
    printCacheSummary(result.metrics.cache, result.config);
  }
  printDiagnosticWarnings(result.metrics);
  console.log('─'.repeat(50));
}

function printCacheSummary(cache, config) {
  const medianText = (value) => value === null ? 'N/A' : formatLatency(value);
  const deltaText = cache.ttftDeltaMs === null
    ? 'N/A'
    : `${cache.ttftDeltaMs >= 0 ? '+' : '-'}${formatLatency(Math.abs(cache.ttftDeltaMs))}`;
  const pairDeltaText = cache.pairDeltas.length > 0
    ? cache.pairDeltas.map((delta) => (
      `${delta >= 0 ? '+' : '-'}${formatLatency(Math.abs(delta))}`
    )).join(', ')
    : 'N/A';
  const ratioText = cache.ttftRatio === null ? 'N/A' : `${cache.ttftRatio.toFixed(2)}×`;
  const serverHitRate = cache.server?.tokenHitRate == null
    ? 'N/A'
    : `${(cache.server.tokenHitRate * 100).toFixed(2)}%`;
  const coveredRequests = cache.server?.requestsWithData ?? 0;
  const prefixValidation = config.prefixValidation;
  const unitCount = config.units?.length ?? 0;

  console.log(chalk.cyan('\n缓存命中探针:'));
  console.log(`  冷组 TTFT 中位数: ${medianText(cache.cold.median)} (n=${cache.cold.n})`);
  console.log(`  热组 TTFT 中位数: ${medianText(cache.warm.median)} (n=${cache.warm.n})`);
  console.log(`  冷-热差值: ${deltaText}`);
  console.log(`  冷/热倍数: ${ratioText}`);
  console.log(`  配对差值（热-冷）: ${pairDeltaText}`);
  console.log(`  一致有利配对: ${cache.pairsFavorable}/${cache.pairsTotal}`);
  console.log(`  Verdict: ${cache.verdict}`);
  console.log(`  Reason: ${cache.reason}`);
  console.log(`  服务端命中率: ${serverHitRate}；覆盖请求: ${coveredRequests}/${config.samples}`);
  console.log(`  前缀自检: 唯一性 ${prefixValidation?.unique?.ok ? '通过' : '失败'}；`
    + `预热前缀匹配 ${prefixValidation?.verified ?? 0}/${unitCount}`);
  if (cache.insufficientSamples) {
    console.log(chalk.yellow('  样本不足，不做结论'));
  }
}

function printDiagnosticWarnings(metrics) {
  const diagnostics = metrics.diagnostics ?? metrics.cache ?? {};
  if (diagnostics.responseCacheSuspected > 0) {
    console.log(chalk.yellow(
      `  ⚠️ 疑似响应级缓存 ${diagnostics.responseCacheSuspected} 条：TPS/解码类指标可能无效`
    ));
  }
  if (diagnostics.truncatedRequests > 0) {
    console.log(chalk.yellow(
      `  ⚠️ ${diagnostics.truncatedRequests} 条请求输出被 max_tokens 截断（结论中的输出长度不代表模型自然长度）`
    ));
  }
}

function formatTpsStatistics(stats) {
  const formattedValues = [stats.mean, stats.median, stats.min, stats.max]
    .map((value) => value.toFixed(2));
  if (new Set(formattedValues).size === 1) {
    return `${formatTps(stats.mean)}（平均/中位数/最小/最大相同）`;
  }
  return `平均 ${formatTps(stats.mean)}；中位数 ${formatTps(stats.median)}；`
    + `最小 ${formatTps(stats.min)}；最大 ${formatTps(stats.max)}`;
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