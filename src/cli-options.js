export function normalizeConcurrencyMode(mode) {
  if (['batch', 'pipeline'].includes(mode)) {
    return mode;
  }

  throw new Error(`无效的并发模式 "${mode}"，可选值仅支持 batch 或 pipeline`);
}
