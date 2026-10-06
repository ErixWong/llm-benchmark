/**
 * Token 统计模块
 *
 * 指标口径（对齐 NVIDIA AIPerf / vLLM / Artificial Analysis）：
 * - TTFT：首个生成 token（含 reasoning）到达时间
 * - TTFO：首个可见 content token（非 reasoning）到达时间
 * - output/completion tokens：含 reasoning 的完整输出
 * - reasoning tokens：优先取服务端 usage.completion_tokens_details.reasoning_tokens，
 *   否则为客户端 tokenizer 估算（两者 tokenizer 不同，口径不可混用）
 */

import { encode } from 'gpt-tokenizer';

/**
 * 读取服务端返回的 reasoning token 数
 * @param {Object|null} apiUsage - 流式响应最后一块的 usage
 * @returns {number|null} 服务端未提供时返回 null
 */
export function getUsageReasoningTokens(apiUsage) {
  const value = apiUsage?.completion_tokens_details?.reasoning_tokens;
  return typeof value === 'number' ? value : null;
}

/**
 * 统计文本的 token 数（不含 chat 模板开销，等价 AIPerf 的 add_special_tokens=False）
 * @param {string} text
 * @returns {number}
 */
export function countTextTokens(text) {
  if (!text) return 0;
  return encode(text).length;
}

/**
 * 汇总单次请求的完成 token 统计。
 *
 * - 服务端返回 usage 时使用服务端口径：content = completion_tokens - reasoning_tokens
 *   在同一次回答内由同一 tokenizer 产生，相减成立。
 * - 服务端未返回 usage 时，content / reasoning 各自独立用客户端 tokenizer 计数，
 *   绝不相减（跨 tokenizer 相减得到的数不对应任何真实计数）。
 *
 * @param {Object} params
 * @param {string} [params.outputText] - 可见内容
 * @param {string} [params.reasoningText] - 推理内容
 * @param {Object|null} [params.apiUsage] - 服务端 usage
 * @returns {{outputTokens:number, contentTokens:number, reasoningTokens:number,
 *            tokenSource:'api'|'tokenizer', reasoningTokenSource:'api'|'tokenizer'}}
 */
export function computeTokenStats({ outputText = '', reasoningText = '', apiUsage = null } = {}) {
  const apiCompletion = typeof apiUsage?.completion_tokens === 'number'
    ? apiUsage.completion_tokens
    : null;
  const apiReasoning = getUsageReasoningTokens(apiUsage);

  const tokenSource = apiCompletion !== null ? 'api' : 'tokenizer';
  const reasoningTokenSource = apiReasoning !== null ? 'api' : 'tokenizer';

  const reasoningTokens = apiReasoning !== null
    ? apiReasoning
    : countTextTokens(reasoningText);

  // 只有两个数同源（都来自服务端 usage）时才做减法
  const contentTokens = apiCompletion !== null && apiReasoning !== null
    ? Math.max(apiCompletion - apiReasoning, 0)
    : countTextTokens(outputText);

  const outputTokens = apiCompletion !== null
    ? apiCompletion
    : contentTokens + reasoningTokens;

  return { outputTokens, contentTokens, reasoningTokens, tokenSource, reasoningTokenSource };
}

export default {
  getUsageReasoningTokens,
  countTextTokens,
  computeTokenStats
};
