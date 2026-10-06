/**
 * --extra-body / EXTRA_BODY 参数处理
 *
 * extra-body 用于透传服务端特有的请求参数（如 vLLM 的
 * chat_template_kwargs.enable_thinking）。但以下键由 benchmark 自己控制，
 * 一旦被覆盖会产生静默错误的结果，因此禁止透传：
 * - stream=false   → 流式解析拿不到任何 data: 行，TTFT/TPS 会变成 null/0
 * - model/messages/max_tokens → 覆盖后本次测量失去意义
 */

/** 禁止通过 extra-body 覆盖的请求体字段 */
export const RESERVED_BODY_KEYS = ['model', 'messages', 'max_tokens', 'stream'];

/**
 * 解析 extra-body JSON 字符串
 * @param {string} raw - JSON 字符串
 * @returns {Object|null} 解析后的纯对象；raw 为空时返回 null
 * @throws {Error} JSON 非法、或解析结果不是 JSON 对象
 */
export function parseExtraBody(raw) {
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`不是合法的 JSON: ${e.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('必须是 JSON 对象，例如 \'{"chat_template_kwargs":{"enable_thinking":false}}\'');
  }

  return parsed;
}

/**
 * 剔除会破坏测量的保留键
 * @param {Object|null} extraBody
 * @returns {{body:Object, dropped:string[]}} body 为可安全透传的参数，dropped 为被忽略的键名
 */
export function sanitizeExtraBody(extraBody) {
  if (!extraBody || typeof extraBody !== 'object' || Array.isArray(extraBody)) {
    return { body: {}, dropped: [] };
  }

  const body = {};
  const dropped = [];

  for (const [key, value] of Object.entries(extraBody)) {
    if (RESERVED_BODY_KEYS.includes(key)) {
      dropped.push(key);
    } else {
      body[key] = value;
    }
  }

  return { body, dropped };
}

export default {
  RESERVED_BODY_KEYS,
  parseExtraBody,
  sanitizeExtraBody
};
