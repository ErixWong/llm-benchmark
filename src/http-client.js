/**
 * HTTP客户端模块
 * 统一处理HTTP请求，包括重试、限流、Keep-Alive
 */

import axios from 'axios';
import { HttpAgent, HttpsAgent } from 'agentkeepalive';
import chalk from 'chalk';

// 从环境变量读取超时配置，默认90秒
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT, 10) || 90000;

/**
 * 自动补全API URL
 * 如果URL不以/chat/completions结尾，自动添加
 * @param {string} url - 原始URL
 * @returns {string} 补全后的URL
 */
export function normalizeApiUrl(url) {
  if (!url) return url;
  
  // 移除末尾斜杠
  let normalizedUrl = url.replace(/\/+$/, '');
  
  // 检查是否已经包含完整路径
  if (normalizedUrl.endsWith('/chat/completions')) {
    return normalizedUrl;
  }
  
  // 检查是否以/v1结尾，自动添加/chat/completions
  if (normalizedUrl.endsWith('/v1')) {
    return normalizedUrl + '/chat/completions';
  }
  
  // 检查是否已经有版本号路径
  if (/\/v\d+$/.test(normalizedUrl)) {
    return normalizedUrl + '/chat/completions';
  }
  
  // 其他情况，添加/v1/chat/completions
  return normalizedUrl + '/v1/chat/completions';
}

/**
 * 检查HTTP状态码是否为错误
 * @param {number} statusCode - HTTP状态码
 * @returns {boolean} 是否为错误状态
 */
export function isErrorStatus(statusCode) {
  return statusCode >= 400;
}

/**
 * 获取状态码类别描述
 * @param {number} statusCode - HTTP状态码
 * @returns {string} 状态描述
 */
export function getStatusCategory(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 'success';
  if (statusCode >= 300 && statusCode < 400) return 'redirect';
  if (statusCode >= 400 && statusCode < 500) return 'client_error';
  if (statusCode >= 500) return 'server_error';
  return 'unknown';
}

// 创建支持Keep-Alive的Agent（使用环境变量配置）
const httpAgent = new HttpAgent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: DEFAULT_TIMEOUT, // Active socket timeout
  freeSocketTimeout: 30000 // Free socket timeout
});

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: DEFAULT_TIMEOUT,
  freeSocketTimeout: 30000
});

// 导出默认超时时间供其他模块使用
export { DEFAULT_TIMEOUT };

/**
 * 默认重试配置
 */
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000, // 基础延迟(毫秒)
  retryMultiplier: 2, // 指数退避乘数
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  retryableErrors: ['ECONNRESET', 'ENOTFOUND', 'ECONNABORTED', 'ETIMEDOUT']
};

/**
 * 创建配置好的Axios实例
 * @param {Object} options - 配置选项
 * @returns {axios.AxiosInstance} Axios实例
 */
export function createHttpClient(options = {}) {
  let {
    baseURL = '',
    timeout = DEFAULT_TIMEOUT,  // 使用环境变量配置的默认超时
    headers = {},
    retryConfig = {}
  } = options;

  // 自动规范化URL
  const originalURL = baseURL;
  baseURL = normalizeApiUrl(baseURL);
  if (baseURL !== originalURL && originalURL) {
    console.log(chalk.gray(`📡 API URL 自动补全: ${originalURL} -> ${baseURL}`));
  }

  const finalRetryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };

  const client = axios.create({
    baseURL,
    timeout,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    httpAgent,
    httpsAgent
  });

  // 请求拦截器
  client.interceptors.request.use(
    (config) => {
      // 添加请求开始时间用于计算耗时
      config.metadata = { startTime: Date.now() };
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // 响应拦截器 - 处理重试
  client.interceptors.response.use(
    (response) => {
      return response;
    },
    async (error) => {
      const { config, response } = error;

      // 如果没有config或已经重试过最大次数，直接返回错误
      if (!config || config.__retryCount >= finalRetryConfig.maxRetries) {
        return Promise.reject(error);
      }

      // 检查是否应该重试
      const shouldRetry = shouldRetryRequest(error, finalRetryConfig);
      if (!shouldRetry) {
        return Promise.reject(error);
      }

      // 初始化重试计数
      config.__retryCount = config.__retryCount || 0;
      config.__retryCount++;

      // 计算延迟时间(指数退避)
      let delay = finalRetryConfig.retryDelay * 
        Math.pow(finalRetryConfig.retryMultiplier, config.__retryCount - 1);

      // 如果是429错误，尝试使用Retry-After头
      if (response?.status === 429) {
        const retryAfter = response.headers['retry-after'];
        if (retryAfter) {
          // Retry-After可能是秒数或日期
          const retryAfterMs = parseRetryAfter(retryAfter);
          if (retryAfterMs > 0) {
            delay = Math.max(delay, retryAfterMs);
          }
        }
        console.log(chalk.yellow(`⏳ API限流，等待 ${delay}ms 后重试 (${config.__retryCount}/${finalRetryConfig.maxRetries})`));
      } else {
        console.log(chalk.yellow(`🔄 请求失败，${delay}ms 后重试 (${config.__retryCount}/${finalRetryConfig.maxRetries})`));
      }

      // 等待后重试
      await sleep(delay);

      // 重新发起请求
      return client(config);
    }
  );

  return client;
}

/**
 * 判断是否应该重试请求
 * @param {Error} error - 错误对象
 * @param {Object} retryConfig - 重试配置
 * @returns {boolean} 是否应该重试
 */
function shouldRetryRequest(error, retryConfig) {
  const { response, code } = error;

  // 检查状态码
  if (response?.status && retryConfig.retryableStatusCodes.includes(response.status)) {
    return true;
  }

  // 检查错误码
  if (code && retryConfig.retryableErrors.includes(code)) {
    return true;
  }

  // 检查错误消息
  if (error.message && retryConfig.retryableErrors.some(e => error.message.includes(e))) {
    return true;
  }

  return false;
}

/**
 * 解析Retry-After头
 * @param {string} retryAfter - Retry-After头的值
 * @returns {number} 延迟毫秒数
 */
function parseRetryAfter(retryAfter) {
  // 尝试解析为数字(秒)
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  // 尝试解析为日期
  try {
    const date = new Date(retryAfter);
    const now = new Date();
    const diff = date.getTime() - now.getTime();
    return diff > 0 ? diff : 0;
  } catch {
    return 0;
  }
}

/**
 * 异步sleep
 * @param {number} ms - 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 参数验证函数
 * @param {Object} params - 参数对象
 * @param {Object} rules - 验证规则
 * @returns {Object} 验证结果 {valid, errors}
 */
export function validateParams(params, rules) {
  const errors = [];

  for (const [key, rule] of Object.entries(rules)) {
    const value = params[key];

    // 必填检查
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(`${key} is required`);
      continue;
    }

    // 如果值不存在且非必填，跳过其他检查
    if (value === undefined || value === null) {
      continue;
    }

    // 类型检查
    if (rule.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== rule.type) {
        errors.push(`${key} must be ${rule.type}, got ${actualType}`);
        continue;
      }
    }

    // 数值范围检查
    if (rule.min !== undefined && typeof value === 'number' && value < rule.min) {
      errors.push(`${key} must be >= ${rule.min}, got ${value}`);
    }
    if (rule.max !== undefined && typeof value === 'number' && value > rule.max) {
      errors.push(`${key} must be <= ${rule.max}, got ${value}`);
    }

    // URL格式检查
    if (rule.url === true && typeof value === 'string') {
      try {
        new URL(value);
      } catch {
        errors.push(`${key} must be a valid URL`);
      }
    }

    // 正则检查
    if (rule.pattern && typeof value === 'string') {
      if (!rule.pattern.test(value)) {
        errors.push(`${key} does not match expected pattern`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 并发测试参数验证规则
 */
export const concurrencyTestRules = {
  url: { required: true, type: 'string', url: true },
  apiKey: { required: false, type: 'string' },
  concurrency: { required: false, type: 'number', min: 1, max: 1000 },
  duration: { required: false, type: 'number', min: 1, max: 3600 },
  rampUp: { required: false, type: 'number', min: 0, max: 300 },
  model: { required: false, type: 'string' }
};

/**
 * Token速度测试参数验证规则
 */
export const tokenSpeedTestRules = {
  url: { required: true, type: 'string', url: true },
  apiKey: { required: false, type: 'string' },
  inputTokens: { required: false, type: 'number', min: 1, max: 128000 },
  maxOutputTokens: { required: false, type: 'number', min: 1, max: 128000 },
  concurrency: { required: false, type: 'number', min: 1, max: 100 },
  samples: { required: false, type: 'number', min: 1, max: 1000 },
  model: { required: false, type: 'string' }
};

// 导出默认客户端
export const httpClient = createHttpClient();

export default {
  createHttpClient,
  validateParams,
  concurrencyTestRules,
  tokenSpeedTestRules,
  httpClient
};