import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the public structure of a prompt bank.
 * @param {*} bank - Parsed bank data
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateBank(bank) {
  const errors = [];
  if (!isRecord(bank)) {
    return { ok: false, errors: ['题库顶层必须是 JSON 对象'] };
  }

  if (typeof bank.name !== 'string' || bank.name.trim() === '') {
    errors.push('题库 name 必须是非空字符串');
  }
  if (!(
    (typeof bank.version === 'string' && bank.version.trim() !== '') ||
    (typeof bank.version === 'number' && Number.isFinite(bank.version) && bank.version >= 0)
  )) {
    errors.push('题库 version 必须是非空字符串或非负数字');
  }
  if (!Array.isArray(bank.items) || bank.items.length === 0) {
    errors.push('题库 items 必须是非空数组');
    return { ok: errors.length === 0, errors };
  }

  const seenIds = new Set();
  for (const [index, item] of bank.items.entries()) {
    const id = isRecord(item) && typeof item.id === 'string' ? item.id : '';
    const label = id.trim()
      ? `条目 #${index + 1}（id="${id}"）`
      : `条目 #${index + 1}`;

    if (!isRecord(item)) {
      errors.push(`${label} 必须是对象`);
      continue;
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      errors.push(`${label}的 id 必须是非空字符串`);
    } else if (seenIds.has(item.id)) {
      errors.push(`${label}的 id 重复`);
    } else {
      seenIds.add(item.id);
    }
    if (typeof item.prompt !== 'string' || item.prompt.trim() === '') {
      errors.push(`${label}的 prompt 必须是非空字符串`);
    }
    if (!isRecord(item.expected)) {
      errors.push(`${label}的 expected 必须是对象`);
    } else {
      if (!Number.isInteger(item.expected.contentTokens) || item.expected.contentTokens < 0) {
        errors.push(`${label}的 expected.contentTokens 必须是非负整数`);
      }
      if (typeof item.expected.text !== 'string') {
        errors.push(`${label}的 expected.text 必须是字符串`);
      }
    }
    if (!isRecord(item.tags) || typeof item.tags.genre !== 'string' || item.tags.genre.trim() === '') {
      errors.push(`${label}的 tags.genre 必须是非空字符串`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Create a short SHA-256 fingerprint for the full bank content.
 * @param {object} bank - Bank data
 * @returns {string} 12-character hexadecimal fingerprint
 */
export function hashBank(bank) {
  const { hash, ...content } = bank;
  return createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Load and validate data/banks/<name>.json beneath the given repository root.
 * @param {string} dir - Repository root
 * @param {string} name - Bank filename without an extension
 * @returns {Promise<object>} Validated bank with content fingerprint
 */
export async function loadBank(dir, name) {
  if (typeof name !== 'string' || name.trim() === '' ||
      name === '.' || name === '..' || path.basename(name) !== name) {
    throw new Error(`无效的题库名称: ${String(name)}`);
  }

  const filePath = path.join(dir, 'data', 'banks', `${name}.json`);
  let contents;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`无法读取题库 "${name}": ${error.message}`);
  }

  let bank;
  try {
    bank = JSON.parse(contents);
  } catch (error) {
    throw new Error(`题库 "${name}" 不是有效 JSON: ${error.message}`);
  }

  const validation = validateBank(bank);
  if (!validation.ok) {
    throw new Error(`题库 "${name}" 校验失败:\n- ${validation.errors.join('\n- ')}`);
  }
  return { ...bank, hash: hashBank(bank) };
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = seed;
  return () => {
    let value = state += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed, tier) {
  const shuffled = [...items];
  const random = createRandom(hashSeed(`${seed}\u0000${tier}`));
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

/**
 * Select a stable segment of the seeded, stratified bank rotation.
 * Each selection contains no duplicate items and each tier advances fairly.
 * @param {object} bank - Validated bank data
 * @param {number} count - Requested item count
 * @param {number} requestIndex - Zero-based request index
 * @param {number|string} seed - Deterministic shuffle seed
 * @returns {object[]} Selected bank items
 */
export function selectBankItems(bank, count, requestIndex, seed) {
  if (!Array.isArray(bank?.items) || !Number.isInteger(count) || count <= 0 || bank.items.length === 0) {
    return [];
  }

  const layers = new Map();
  for (const item of bank.items) {
    const tier = typeof item.tags?.outputTier === 'string' && item.tags.outputTier.trim()
      ? item.tags.outputTier
      : '__default__';
    if (!layers.has(tier)) layers.set(tier, []);
    layers.get(tier).push(item);
  }

  const shuffledLayers = [...layers.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([tier, items]) => shuffle(items, seed, tier));
  const schedule = [];
  const offsets = shuffledLayers.map(() => 0);
  let remaining = bank.items.length;
  while (remaining > 0) {
    for (let layerIndex = 0; layerIndex < shuffledLayers.length; layerIndex++) {
      const items = shuffledLayers[layerIndex];
      if (offsets[layerIndex] < items.length) {
        schedule.push(items[offsets[layerIndex]++]);
        remaining--;
      }
    }
  }

  const selectedCount = Math.min(count, schedule.length);
  const safeRequestIndex = Number.isInteger(requestIndex) && requestIndex >= 0 ? requestIndex : 0;
  const start = ((safeRequestIndex % schedule.length) * (count % schedule.length)) % schedule.length;
  return Array.from(
    { length: selectedCount },
    (_, index) => schedule[(start + index) % schedule.length]
  );
}

/**
 * Resolve an explicit ordered list of bank item IDs.
 * @param {object} bank - Validated bank data
 * @param {string[]} ids - Ordered item IDs
 * @returns {object[]} Items in the requested order
 */
export function selectBankItemsByIds(bank, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('--bank-items 必须至少包含一个条目 ID');
  }

  const itemsById = new Map(bank.items.map(item => [item.id, item]));
  return ids.map((id) => {
    const item = itemsById.get(id);
    if (!item) {
      throw new Error(`题库 "${bank.name}" 中不存在条目 id "${id}"`);
    }
    return item;
  });
}

export default {
  validateBank,
  loadBank,
  selectBankItems,
  selectBankItemsByIds,
  hashBank
};
