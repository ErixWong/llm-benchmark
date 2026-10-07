/**
 * 按种子偏移和单元序号从已排序样本中轮转一整轮。
 * @param {string[]} sortedFiles - 已排序的样本文件
 * @param {number} unitIndex - 探测单元序号
 * @param {number} seedOffset - 起点偏移
 * @returns {string[]} 以确定性环序排列的样本文件
 */
export function selectDocuments(sortedFiles, unitIndex, seedOffset) {
  if (sortedFiles.length === 0) return [];

  const start = ((seedOffset + unitIndex) % sortedFiles.length + sortedFiles.length)
    % sortedFiles.length;
  return sortedFiles.map((_, index) => sortedFiles[(start + index) % sortedFiles.length]);
}

/**
 * 为每个缓存单元按冷请求、热请求的顺序生成计时请求计划。
 * 按计划顺序第 i 个 miss 与第 i 个 hit 属于同一单元，应作为一对比较。
 * @param {Array<{cold:string,warm:string}>} units - 缓存探测单元
 * @returns {Array<{text:string,intent:'miss'|'hit'}>} 计时请求计划
 */
export function buildRequestPlan(units) {
  return units.flatMap((unit) => [
    { text: unit.cold, intent: 'miss' },
    { text: unit.warm, intent: 'hit' }
  ]);
}

export default {
  selectDocuments,
  buildRequestPlan
};
