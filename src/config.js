/**
 * 配置加载模块
 * 加载并处理配置文件中的变量替换
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 加载配置文件
 * @param {string} configPath - 配置文件路径
 * @returns {Object} 配置对象
 */
export function loadConfig(configPath = path.join(__dirname, '../config/default.json')) {
  try {
    // 检查配置文件是否存在
    if (!fs.existsSync(configPath)) {
      console.warn(`配置文件不存在: ${configPath}，使用默认配置`);
      return getDefaultConfig();
    }

    // 读取配置文件内容
    let configStr = fs.readFileSync(configPath, 'utf-8');

    // 替换环境变量占位符 ${VAR_NAME}
    configStr = configStr.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        console.warn(`环境变量 ${varName} 未设置`);
        return '';
      }
      return value;
    });

    return JSON.parse(configStr);
  } catch (error) {
    console.error(`加载配置文件失败: ${error.message}`);
    return getDefaultConfig();
  }
}

/**
 * 获取默认配置
 * @returns {Object} 默认配置对象
 */
function getDefaultConfig() {
  return {
    api: {
      baseUrl: process.env.API_BASE_URL || '',
      apiKey: process.env.API_KEY || '',
      model: process.env.API_MODEL || 'gpt-3.5-turbo',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    },
    test: {
      concurrency: {
        levels: [1, 5, 10, 20, 50, 100],
        duration: 60,
        rampUp: 10,
        samples: 3
      },
      tokenSpeed: {
        inputTokens: [100, 500, 1000, 2000],
        maxOutputTokens: 500,
        concurrency: [1, 5, 10],
        samples: 10,
        warmupRequests: 3
      },
      stress: {
        startConcurrency: 10,
        endConcurrency: 500,
        step: 10,
        duration: 300,
        rampUp: 30
      }
    },
    report: {
      outputDir: './results',
      formats: ['json', 'html', 'markdown'],
      includeRawData: true,
      percentiles: [50, 75, 90, 95, 99]
    },
    thresholds: {
      responseTime: {
        p50: 500,
        p90: 1000,
        p99: 2000
      },
      errorRate: 1,
      minRps: 10,
      minTps: 10
    }
  };
}

/**
 * 合并配置
 * @param {Object} defaultConfig - 默认配置
 * @param {Object} userConfig - 用户配置
 * @returns {Object} 合并后的配置
 */
export function mergeConfig(defaultConfig, userConfig) {
  const result = { ...defaultConfig };
  
  for (const key in userConfig) {
    if (Object.hasOwn(userConfig, key)) {
      if (typeof userConfig[key] === 'object' && !Array.isArray(userConfig[key]) && userConfig[key] !== null) {
        result[key] = mergeConfig(result[key] || {}, userConfig[key]);
      } else {
        result[key] = userConfig[key];
      }
    }
  }
  
  return result;
}

export default {
  loadConfig,
  mergeConfig
};