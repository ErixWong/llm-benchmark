/**
 * 上下文生成器模块
 * 精确控制输入token数量
 */

import { encode, countTokens as countTextTokenizerTokens } from 'gpt-tokenizer';
import { countTokens as countChatTokenizerTokens } from 'gpt-tokenizer/model/gpt-3.5-turbo';

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
 * 生成精确token数量的文本（优化版）
 * @param {number} targetTokens - 目标token数量
 * @returns {string} 生成的文本
 */
export function generateExactTokenText(targetTokens) {
  if (targetTokens <= 0) {
    return '';
  }

  const baseText = 'The quick brown fox jumps over the lazy dog. Performance testing ensures API reliability and efficiency under load. ';
  const baseTokens = encode(baseText);
  const baseLen = baseTokens.length;

  if (targetTokens <= baseLen) {
    const text = baseText.slice(0, Math.ceil(targetTokens * 3));
    return adjustToExactTokens(text, targetTokens);
  }

  const repetitions = Math.floor(targetTokens / baseLen);
  const remainingTokens = targetTokens - (repetitions * baseLen);

  let text = baseText.repeat(repetitions);

  if (remainingTokens > 0) {
    const filler = generateFillerText(remainingTokens);
    text += filler;
  }

  return adjustToExactTokens(text, targetTokens);
}

/**
 * 生成填充文本（优化：预计算+二分查找）
 * @param {number} targetTokens - 目标token数量
 * @returns {string} 填充文本
 */
function generateFillerText(targetTokens) {
  const candidates = [];
  const step = Math.max(1, Math.floor(targetTokens / 10));

  for (let len = step; len <= targetTokens * 2; len += step) {
    const text = 'abcdefghijklmnopqrstuvwxyz '.repeat(Math.ceil(len / 27)).slice(0, len);
    const tokens = encode(text).length;
    if (tokens <= targetTokens * 1.5) {
      candidates.push({ text, tokens });
    }
  }

  if (candidates.length === 0) {
    return 'a '.repeat(targetTokens);
  }

  candidates.sort((a, b) => a.tokens - b.tokens);

  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c.tokens - targetTokens) < Math.abs(best.tokens - targetTokens)) {
      best = c;
    }
  }

  return best.text;
}

/**
 * 调整文本到精确的token数量（优化：减少encode调用）
 * @param {string} text - 原始文本
 * @param {number} targetTokens - 目标token数量
 * @returns {string} 调整后的文本
 */
function adjustToExactTokens(text, targetTokens) {
  let currentTokens = encode(text).length;

  if (currentTokens === targetTokens) {
    return text;
  }

  if (currentTokens > targetTokens) {
    const chars = text.split('');
    let left = 0, right = chars.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      const temp = chars.slice(0, mid).join('');
      const tokens = encode(temp).length;

      if (tokens >= targetTokens) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }

    return chars.slice(0, left).join('');
  }

  const padding = 'x ';
  let result = text;
  let paddingIdx = 0;

  while (encode(result).length < targetTokens) {
    result += padding[paddingIdx++ % padding.length];
  }

  return result;
}

/**
 * 计算消息数组的token数量
 * @param {Array} messages - OpenAI格式的消息数组
 * @returns {number} token数量
 */
export function countMessagesTokens(messages) {
  return countChatTokenizerTokens(messages);
}

/**
 * 计算纯文本的token数量
 * @param {string} text - 文本内容
 * @returns {number} token数量
 */
export function countTextTokens(text) {
  if (!text) {
    return 0;
  }

  return countTextTokenizerTokens(text);
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
  countTextTokens,
  estimateTokens,
  validateContext
};
