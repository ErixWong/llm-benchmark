import { randomBytes } from 'node:crypto';
import { hashText, countTokens } from './cache-source.js';

const SAFE_CHARACTERS = '23456789abcdefghjkmnpqrstuvwxyz';

/**
 * 生成 4 字符的无混淆随机运行盐。
 * @returns {string} 由安全字符集组成的 4 字符盐
 */
export function makeRunSalt() {
  const salt = [];
  const limit = Math.floor(256 / SAFE_CHARACTERS.length) * SAFE_CHARACTERS.length;

  while (salt.length < 4) {
    for (const byte of randomBytes(4)) {
      if (byte >= limit) continue;
      salt.push(SAFE_CHARACTERS[byte % SAFE_CHARACTERS.length]);
      if (salt.length === 4) break;
    }
  }

  return salt.join('');
}

/**
 * 按输入素材构造确定性的冷热配对前缀。
 * @param {{materials?:{id:string,text:string,tokens:number}[],suffix?:string,runSalt:string}} params
 * @returns {Array<{unitIndex:number,itemId:string,prefixHash:string,prefixTokens:number,
 *                  primed:string,warm:string,cold:string,warmNonce:string,coldNonce:string}>}
 */
export function buildProbeUnits({ materials = [], suffix, runSalt } = {}) {
  const sourceMaterials = materials ?? [];
  if (!Array.isArray(sourceMaterials)) {
    throw new TypeError('materials 必须是数组');
  }

  const sharedSuffix = typeof suffix === 'string' ? suffix : '';
  const width = Math.max(3, String(sourceMaterials.length - 1).length);

  return sourceMaterials.map((material, unitIndex) => {
    const unitNumber = String(unitIndex).padStart(width, '0');
    const warmNonce = `[c-${runSalt}-w${unitNumber}]`;
    const coldNonce = `[c-${runSalt}-c${unitNumber}]`;
    const primed = warmNonce + material.text;

    return {
      unitIndex,
      itemId: material.id,
      prefixHash: hashText(primed),
      prefixTokens: countTokens(primed),
      primed,
      warm: primed + sharedSuffix,
      cold: coldNonce + material.text + sharedSuffix,
      warmNonce,
      coldNonce
    };
  });
}

/**
 * 验证预热前缀是否确实位于热请求文本开头。
 * @param {unknown} primedText - 预热时使用的前缀
 * @param {unknown} warmText - 热请求文本
 * @returns {{ok:boolean,reason?:string}} 前缀校验结果
 */
export function verifyPrefix(primedText, warmText) {
  if (typeof primedText !== 'string' || typeof warmText !== 'string') {
    return { ok: false, reason: '预热前缀和热请求文本都必须是字符串' };
  }
  if (primedText.length === 0) {
    return { ok: false, reason: '预热前缀不能为空' };
  }
  if (!warmText.startsWith(primedText)) {
    return { ok: false, reason: '热请求文本不是以预热前缀开头' };
  }

  return { ok: true };
}

/**
 * 检查所有单元的预热、热、冷文本是否两两唯一。
 * @param {Array<Object>} units - 待检查的探测单元
 * @returns {{ok:boolean,duplicates:string[]}} 重复文本按首次发现顺序排列，最多 10 条
 */
export function checkUniquePrefixes(units = []) {
  const seen = new Set();
  const duplicateSet = new Set();
  const duplicates = [];

  for (const unit of units ?? []) {
    for (const prefix of [unit?.primed, unit?.warm, unit?.cold]) {
      if (typeof prefix !== 'string') continue;
      if (seen.has(prefix) && !duplicateSet.has(prefix)) {
        duplicateSet.add(prefix);
        duplicates.push(prefix);
        if (duplicates.length === 10) {
          return { ok: false, duplicates };
        }
      }
      seen.add(prefix);
    }
  }

  return { ok: duplicates.length === 0, duplicates };
}

export default {
  makeRunSalt,
  buildProbeUnits,
  verifyPrefix,
  checkUniquePrefixes
};
