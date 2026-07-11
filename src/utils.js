/**
 * 通用工具函数模块
 * 提取自各模块的独立工具函数，便于测试和复用
 */

import chalk from 'chalk';

/**
 * 安全解析整数，验证 NaN
 * @param {string} value - 字符串值
 * @param {number} defaultValue - 默认值
 * @param {string} name - 参数名称 (用于错误提示)
 * @param {boolean} quiet - 是否静默模式
 * @returns {number} 解析后的整数
 */
export function safeParseInt(value, defaultValue, name, quiet = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    if (!quiet) {
      console.warn(chalk.yellow(`⚠️ 参数 ${name} 值 "${value}" 不是有效数字，使用默认值 ${defaultValue}`));
    }
    return defaultValue;
  }
  return parsed;
}
