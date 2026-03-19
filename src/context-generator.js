/**
 * 上下文生成器模块
 * 精确控制输入token数量
 */

import { encode, decode } from 'gpt-tokenizer';

/**
 * 生成精确token数量的测试提示词
 * @param {number} targetTokens - 目标token数量
 * @param {Object} options - 配置选项
 * @param {string} options.systemPrompt - 系统提示词
 * @param {number} options.contextRounds - 多轮对话轮数
 * @param {number} options.tokensPerRound - 每轮对话的token数
 * @returns {Object} 包含messages数组和实际token数的对象
 */
export function generateContext(targetTokens, options = {}) {
  const {
    systemPrompt = null,
    contextRounds = 0,
    tokensPerRound = 100
  } = options;

  const messages = [];

  // 添加系统提示词
  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt
    });
  }

  // 多轮对话模式
  if (contextRounds > 0) {
    return generateMultiRoundContext(targetTokens, {
      systemPrompt,
      contextRounds,
      tokensPerRound
    });
  }

  // 单轮对话模式
  const userContent = generateExactTokenText(targetTokens);
  messages.push({
    role: 'user',
    content: userContent
  });

  // 计算实际token数
  const actualTokens = countMessagesTokens(messages);

  return {
    messages,
    actualTokens,
    targetTokens
  };
}

/**
 * 生成多轮对话上下文
 * @param {number} targetTokens - 目标总token数
 * @param {Object} options - 配置选项
 * @returns {Object} 包含messages数组和实际token数的对象
 */
function generateMultiRoundContext(targetTokens, options) {
  const { systemPrompt, contextRounds, tokensPerRound } = options;
  const messages = [];

  // 添加系统提示词
  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt
    });
  }

  // 计算系统提示词占用的token
  const systemTokens = systemPrompt ? countMessagesTokens(messages) : 0;
  const remainingTokens = targetTokens - systemTokens;

  // 每轮对话包括用户消息和助手回复
  // 格式开销：每条消息约4 tokens (role + 格式)
  const formatOverhead = contextRounds * 2 * 4;
  const availableForContent = remainingTokens - formatOverhead;
  const tokensPerMessage = Math.floor(availableForContent / (contextRounds * 2));

  for (let i = 0; i < contextRounds; i++) {
    // 用户消息
    const userContent = generateExactTokenText(tokensPerMessage);
    messages.push({
      role: 'user',
      content: `[Round ${i + 1}] ${userContent}`
    });

    // 助手回复（模拟）
    const assistantContent = generateExactTokenText(tokensPerMessage);
    messages.push({
      role: 'assistant',
      content: `[Response ${i + 1}] ${assistantContent}`
    });
  }

  // 添加最终用户问题
  const finalTokens = Math.max(50, Math.floor(tokensPerMessage / 2));
  const finalContent = generateExactTokenText(finalTokens);
  messages.push({
    role: 'user',
    content: `Please answer: ${finalContent}`
  });

  const actualTokens = countMessagesTokens(messages);

  return {
    messages,
    actualTokens,
    targetTokens,
    contextRounds
  };
}

/**
 * 生成精确token数量的文本
 * @param {number} targetTokens - 目标token数量
 * @returns {string} 生成的文本
 */
export function generateExactTokenText(targetTokens) {
  if (targetTokens <= 0) {
    return '';
  }

  // 基础文本模板
  const baseText = 'This is a performance test message for API benchmarking purposes. ';
  const baseTokens = encode(baseText);

  // 计算需要重复的次数
  const repetitions = Math.floor(targetTokens / baseTokens.length);
  const remainingTokens = targetTokens % baseTokens.length;

  // 构建文本
  let text = baseText.repeat(repetitions);

  // 添加剩余部分
  if (remainingTokens > 0) {
    // 逐字添加直到达到目标token数
    let partialText = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz ';
    
    for (let i = 0; i < remainingTokens * 4; i++) {
      partialText += chars[i % chars.length];
      if (encode(text + partialText).length >= targetTokens) {
        break;
      }
    }
    
    text += partialText;
  }

  // 精确调整：截断或填充
  text = adjustToExactTokens(text, targetTokens);

  return text;
}

/**
 * 调整文本到精确的token数量
 * @param {string} text - 原始文本
 * @param {number} targetTokens - 目标token数量
 * @returns {string} 调整后的文本
 */
function adjustToExactTokens(text, targetTokens) {
  let currentTokens = encode(text).length;

  // 如果token数过多，逐步截断
  while (currentTokens > targetTokens && text.length > 0) {
    text = text.slice(0, -1);
    currentTokens = encode(text).length;
  }

  // 如果token数过少，逐步填充
  const paddingChars = 'x ';
  while (currentTokens < targetTokens) {
    text += paddingChars[currentTokens % paddingChars.length];
    currentTokens = encode(text).length;
  }

  return text;
}

/**
 * 计算消息数组的token数量
 * @param {Array} messages - OpenAI格式的消息数组
 * @returns {number} token数量
 */
export function countMessagesTokens(messages) {
  // OpenAI消息格式的token计算
  // 每条消息约有格式开销
  let totalTokens = 0;

  for (const message of messages) {
    // 角色开销
    totalTokens += 4; // <|start|>role<|message|>
    
    // 内容token
    if (message.content) {
      totalTokens += encode(message.content).length;
    }
  }

  // 消息数组的整体开销
  totalTokens += 3; // <|start|>assistant<|message|>

  return totalTokens;
}

/**
 * 估算文本的token数量（不使用tokenizer时的备选方案）
 * @param {string} text - 文本
 * @returns {number} 估算的token数
 */
export function estimateTokens(text) {
  if (!text) return 0;
  
  // 中文约1.5字符=1token
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  // 英文约4字符=1token
  const otherChars = text.length - chineseChars;
  
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 验证上下文token数量
 * @param {Array} messages - 消息数组
 * @param {number} expectedTokens - 预期的token数
 * @returns {Object} 验证结果
 */
export function validateContext(messages, expectedTokens) {
  const actualTokens = countMessagesTokens(messages);
  const difference = actualTokens - expectedTokens;
  const accuracy = expectedTokens > 0 ? (1 - Math.abs(difference) / expectedTokens) * 100 : 100;

  return {
    valid: Math.abs(difference) <= 2, // 允许2个token的误差
    actualTokens,
    expectedTokens,
    difference,
    accuracy: accuracy.toFixed(2) + '%'
  };
}

export default {
  generateContext,
  generateExactTokenText,
  countMessagesTokens,
  estimateTokens,
  validateContext
};