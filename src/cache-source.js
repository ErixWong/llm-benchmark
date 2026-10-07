import { createHash } from 'node:crypto';
import { encode, decode } from 'gpt-tokenizer';

/**
 * 统计文本的 token 数。
 * @param {string} text - 要统计的文本
 * @returns {number} token 数量
 */
export function countTokens(text) {
  return encode(text).length;
}

/**
 * 生成文本的 SHA-256 前缀摘要。
 * @param {string} text - 要计算摘要的文本
 * @returns {string} 12 位十六进制摘要
 */
export function hashText(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * 按 Markdown 二级与三级标题切分文本，并保留所有原始字符。
 * @param {string} text - Markdown 文本
 * @returns {{heading:string, text:string}[]} 按原顺序排列的文本块
 */
export function chunkByHeadings(text) {
  const headings = [];
  let lineStart = 0;

  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, end).replace(/\r$/, '');

    if (/^## /.test(line) || /^### /.test(line)) {
      headings.push({ start: lineStart, heading: line });
    }

    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }

  if (headings.length === 0) {
    return text.length > 0 ? [{ heading: '', text }] : [];
  }

  const chunks = [];
  if (headings[0].start > 0) {
    chunks.push({ heading: '', text: text.slice(0, headings[0].start) });
  }

  for (let i = 0; i < headings.length; i++) {
    const { start, heading } = headings[i];
    const end = headings[i + 1]?.start ?? text.length;
    chunks.push({ heading, text: text.slice(start, end) });
  }

  return chunks;
}

/**
 * 按给定文档顺序组合达到目标长度的确定性素材。
 * @param {{documents:{name:string, text:string}[], targetTokens:number}} params
 * @returns {{text:string, tokens:number, hash:string}} 拼接文本、token 数与摘要
 */
export function buildMaterial({ documents, targetTokens }) {
  let text = '';

  if (targetTokens > 0) {
    material: for (const document of documents) {
      for (const chunk of chunkByHeadings(document.text)) {
        const separator = text ? '\n\n' : '';
        const candidate = text + separator + chunk.text;

        if (countTokens(candidate) <= targetTokens) {
          text = candidate;
          if (countTokens(text) >= targetTokens) break material;
          continue;
        }

        const tokens = encode(chunk.text);
        let low = 0;
        let high = tokens.length;
        let bestText = text;

        while (low <= high) {
          const length = Math.floor((low + high) / 2);
          let prefixLength = length;
          let partial = decode(tokens.slice(0, length));

          while (prefixLength > 0 && partial.includes('\uFFFD')) {
            prefixLength--;
            partial = decode(tokens.slice(0, prefixLength));
          }

          const truncated = partial ? text + separator + partial : text;
          if (countTokens(truncated) <= targetTokens) {
            bestText = truncated;
            low = length + 1;
          } else {
            high = prefixLength - 1;
          }
        }

        text = bestText;
        break material;
      }
    }
  }

  return {
    text,
    tokens: countTokens(text),
    hash: hashText(text)
  };
}

export default {
  countTokens,
  hashText,
  chunkByHeadings,
  buildMaterial
};
