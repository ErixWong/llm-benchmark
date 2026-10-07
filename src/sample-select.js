/**
 * Selects a deterministic, non-repeating ring segment for one request.
 * @param {string[]} sortedFiles - Sorted sample file paths
 * @param {number} sampleCount - Number of files to select
 * @param {number} requestIndex - Zero-based request index
 * @param {number} seed - Starting offset seed
 * @returns {string[]} Selected file paths
 */
export function selectSampleFiles(sortedFiles, sampleCount, requestIndex, seed) {
  const files = [...new Set(sortedFiles)].sort();
  if (files.length === 0 || sampleCount <= 0) {
    return [];
  }

  const count = Math.min(sampleCount, files.length);
  if (count === files.length) {
    return files;
  }

  const offset = seed + requestIndex * count;
  const start = ((offset % files.length) + files.length) % files.length;
  return Array.from({ length: count }, (_, index) => files[(start + index) % files.length]);
}
