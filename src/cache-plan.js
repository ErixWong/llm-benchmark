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
 * 每条计划请求都带单元标识，配对不依赖过滤成功请求后的序位。
 * @param {Array<{cold:string,warm:string,unitIndex:number}>} units - 缓存探测单元
 * @returns {Array<{text:string,intent:'miss'|'hit',unitIndex:number}>} 计时请求计划
 */
export function buildRequestPlan(units) {
  return units.flatMap((unit) => [
    { text: unit.cold, intent: 'miss', unitIndex: unit.unitIndex },
    { text: unit.warm, intent: 'hit', unitIndex: unit.unitIndex }
  ]);
}

export default {
  selectDocuments,
  buildRequestPlan
};
