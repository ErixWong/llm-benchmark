/**
 * 报告生成器模块
 * 生成测试结果报告
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { shouldWarnAboutTps, shouldCollapseTpsStatistics } from './cache-stats.js';

/**
 * HTML转义函数，防止XSS攻击
 * @param {string} str - 原始字符串
 * @returns {string} 转义后的字符串
 */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/**
 * Markdown 内联文本转义：中和内联 HTML 并压平换行（错误文本可能来自服务端）
 * @param {*} str
 * @returns {string}
 */
function inlineMarkdown(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/[<>]/g, c => ({ '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/\s*\n\s*/g, ' ');
}

function cacheVerdictLabel(verdict) {
  return {
    benefit: '观察到缓存收益',
    'no-benefit': '未观察到缓存收益',
    inconclusive: '结论不确定'
  }[verdict] || '结论不确定';
}

function cacheReasonLabel(reason) {
  return {
    'insufficient-samples': '样本不足（有效配对少于 3 或冷热组样本不足）',
    'server-reports-zero': '服务端报告零缓存命中',
    'consistent-benefit': '配对差值一致支持收益',
    'inconsistent-pair-deltas': '服务端报告命中，但配对差值不一致',
    'no-consistent-benefit': '未观察到一致的配对收益'
  }[reason] || '判定原因未知';
}

function formatCacheLatency(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(0)} ms`
    : 'N/A';
}

function formatCacheDelta(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A';
  return `${value >= 0 ? '+' : '-'}${formatCacheLatency(Math.abs(value))}`;
}

function formatCacheRatio(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)}×`
    : 'N/A';
}

function formatCachePairDeltas(values) {
  return Array.isArray(values) && values.length > 0
    ? values.map(formatCacheDelta).join(', ')
    : 'N/A';
}

function getCachePrefixSummary(config) {
  const validation = config?.prefixValidation;
  const unitCount = config?.units?.length ?? 0;
  const unique = validation?.unique?.ok ? '通过' : '失败';
  return `唯一性 ${unique}；预热前缀匹配 ${validation?.verified ?? 0}/${unitCount}`;
}

function getDiagnostics(metrics) {
  if (metrics.diagnostics) return metrics.diagnostics;
  return {
    responseCacheSuspected: metrics.cache?.responseCacheSuspected ?? 0,
    truncatedRequests: metrics.cache?.truncatedRequests ?? 0
  };
}

function getDiagnosticWarnings(metrics) {
  const diagnostics = getDiagnostics(metrics);
  const warnings = [];
  if (diagnostics.responseCacheSuspected > 0) {
    warnings.push(
      `⚠️ 疑似响应级缓存 ${diagnostics.responseCacheSuspected} 条：TPS/解码类指标可能无效`
    );
  }
  if (diagnostics.truncatedRequests > 0) {
    warnings.push(
      `⚠️ ${diagnostics.truncatedRequests} 条请求输出被 max_tokens 截断（结论中的输出长度不代表模型自然长度）`
    );
  }
  return warnings;
}

function getTpsSampleCount(tokenSpeed) {
  return Array.isArray(tokenSpeed.metrics.tps.values)
    ? tokenSpeed.metrics.tps.values.length
    : tokenSpeed.config.samples;
}

function shouldShowTpsWarning(tokenSpeed) {
  return shouldWarnAboutTps({
    outputTokensMedian: tokenSpeed.metrics.outputTokens.median,
    truncatedRequests: getDiagnostics(tokenSpeed.metrics).truncatedRequests,
    totalRequests: tokenSpeed.config.samples
  });
}

function formatTpsStatistics(stats) {
  const formattedValues = [stats.mean, stats.median, stats.min, stats.max]
    .map((value) => value.toFixed(2));
  if (new Set(formattedValues).size === 1) {
    return `${formattedValues[0]} tokens/s（平均/中位数/最小/最大相同）`;
  }
  return `平均 ${formattedValues[0]} / 中位数 ${formattedValues[1]} / `
    + `最小 ${formattedValues[2]} / 最大 ${formattedValues[3]} tokens/s`;
}

function formatUtc8Timestamp(date) {
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${utc8Date.toISOString().slice(0, 19).replace('T', ' ')} +08:00`;
}

function escapeMarkdownTableCell(value) {
  return inlineMarkdown(value).replace(/\|/g, '\\|');
}

function sanitizeReportUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) {
      if (/api[-_]?key|key|token|secret|password|authorization/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactSensitiveFields(value) {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [
    key,
    /api[-_]?key|authorization|(?:access|refresh|auth)[-_]?token|secret|password/i.test(key)
      ? '[REDACTED]'
      : redactSensitiveFields(nestedValue)
  ]));
}

function appendCacheMarkdown(lines, cache, config) {
  const cold = cache.cold || {};
  const warm = cache.warm || {};
  const server = cache.server;
  const sampleCount = config?.samples ?? '-';

  lines.push('### 缓存命中');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|------|-----|');
  lines.push(`| 冷组 TTFT 中位数 | ${formatCacheLatency(cold.median)}（n=${cold.n ?? 0}）|`);
  lines.push(`| 冷组 TTFT min / max | ${formatCacheLatency(cold.min)} / ${formatCacheLatency(cold.max)} |`);
  lines.push(`| 热组 TTFT 中位数 | ${formatCacheLatency(warm.median)}（n=${warm.n ?? 0}）|`);
  lines.push(`| 热组 TTFT min / max | ${formatCacheLatency(warm.min)} / ${formatCacheLatency(warm.max)} |`);
  lines.push(`| 冷-热 TTFT 差值（中位数之差） | ${formatCacheDelta(cache.ttftDeltaMs)} |`);
  lines.push(`| 冷/热 TTFT 倍数 | ${formatCacheRatio(cache.ttftRatio)} |`);
  lines.push(`| 配对差值（热-冷，按单元） | ${formatCachePairDeltas(cache.pairDeltas)} |`);
  lines.push(`| 一致有利配对 | ${cache.pairsFavorable ?? 0}/${cache.pairsTotal ?? 0} |`);
  lines.push(`| 判定 | ${cacheVerdictLabel(cache.verdict)} |`);
  lines.push(`| 判定原因 | ${cacheReasonLabel(cache.reason)} |`);
  lines.push(`| 服务端 token 命中率 | ${server?.tokenHitRate == null ? '未知' : `${(server.tokenHitRate * 100).toFixed(2)}%`} |`);
  lines.push(`| 服务端数据覆盖请求数 | ${server?.requestsWithData ?? 0}/${sampleCount} |`);
  lines.push(`| 前缀自检 | ${getCachePrefixSummary(config)} |`);
  lines.push('');
  if (server === null) {
    lines.push('> 服务端未上报缓存字段；结论依据为成对 TTFT 行为，不代表服务端确认命中。');
    lines.push('');
  }
  if (cache.insufficientSamples) {
    lines.push('> 样本不足，不做结论。');
    lines.push('');
  }
}

function generateCacheHtml(cache, config) {
  const cold = cache.cold || {};
  const warm = cache.warm || {};
  const server = cache.server;
  const sampleCount = config?.samples ?? '-';
  const safe = (value) => escapeHtml(String(value ?? 'N/A'));
  const hitRate = server?.tokenHitRate == null
    ? '未知'
    : `${(server.tokenHitRate * 100).toFixed(2)}%`;
  const rows = [
    ['冷组 TTFT 中位数', `${formatCacheLatency(cold.median)}（n=${cold.n ?? 0}）`],
    ['冷组 TTFT min / max', `${formatCacheLatency(cold.min)} / ${formatCacheLatency(cold.max)}`],
    ['热组 TTFT 中位数', `${formatCacheLatency(warm.median)}（n=${warm.n ?? 0}）`],
    ['热组 TTFT min / max', `${formatCacheLatency(warm.min)} / ${formatCacheLatency(warm.max)}`],
    ['冷-热 TTFT 差值（中位数之差）', formatCacheDelta(cache.ttftDeltaMs)],
    ['冷/热 TTFT 倍数', formatCacheRatio(cache.ttftRatio)],
    ['配对差值（热-冷，按单元）', formatCachePairDeltas(cache.pairDeltas)],
    ['一致有利配对', `${cache.pairsFavorable ?? 0}/${cache.pairsTotal ?? 0}`],
    ['判定', cacheVerdictLabel(cache.verdict)],
    ['判定原因', cacheReasonLabel(cache.reason)],
    ['服务端 token 命中率', hitRate],
    ['服务端数据覆盖请求数', `${server?.requestsWithData ?? 0}/${sampleCount}`],
    ['前缀自检', getCachePrefixSummary(config)]
  ];
  const notes = [
    ...(server === null
      ? ['服务端未上报缓存字段；结论依据为成对 TTFT 行为，不代表服务端确认命中。']
      : []),
    ...(cache.insufficientSamples ? ['样本不足，不做结论。'] : [])
  ];

  return `
      <section class="card cache-probe">
        <h3>缓存命中</h3>
        <table>
          <tr><th>指标</th><th>值</th></tr>
          ${rows.map(([label, value]) => `<tr><td>${safe(label)}</td><td>${safe(value)}</td></tr>`).join('')}
        </table>
        ${notes.map((note) => `<p>${safe(note)}</p>`).join('')}
      </section>`;
}

/**
 * 序列化嵌入 <script> 块的数据，防止提前闭合 script 或行分隔符注入
 * （错误信息等字符串来自服务端，不能直接拼进脚本上下文）
 * @param {*} value - 任意可序列化值
 * @returns {string}
 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 指标口径版本：major 表示既有字段含义发生不兼容变更；minor 表示纯新增字段。
 * v1.0: TTFT = 首个生成 token（含 reasoning）；新增 ttfo / tokenSource；移除 decodeThroughputTps
 * v1.1: 新增可选的 metrics.cache 缓存探针结果（含配对判定规则；该功能与其判定规则在同一未发布版本内定型）
 * v1.2: 新增通用 metrics.diagnostics
 */
const METRICS_VERSION = 1.2;

/**
 * 是否将模型输出全文写入 JSON 报告（默认不写：体积大且含模型完整输出）
 * @returns {boolean}
 */
function shouldIncludeOutputText() {
  return /^(1|true|yes)$/i.test(process.env.REPORT_INCLUDE_TEXT || '');
}

/**
 * 从结果副本剥离 outputText / reasoningText（浅拷贝 + 映射 raw/failed 条目，不修改入参）
 * @param {Object} results
 * @returns {Object}
 */
function stripOutputText(results) {
  const stripped = { ...results };
  if (stripped.tokenSpeed) {
    const tokenSpeed = { ...stripped.tokenSpeed };
    for (const key of ['raw', 'failed']) {
      if (Array.isArray(tokenSpeed[key])) {
        tokenSpeed[key] = tokenSpeed[key].map(({ outputText, reasoningText, ...rest }) => rest);
      }
    }
    stripped.tokenSpeed = tokenSpeed;
  }
  return stripped;
}

function redactReportSecrets(results) {
  const sanitized = { ...results };
  if (sanitized.tokenSpeed?.config) {
    sanitized.tokenSpeed = { ...sanitized.tokenSpeed };
    sanitized.tokenSpeed.config = redactSensitiveFields(sanitized.tokenSpeed.config);
    if (typeof sanitized.tokenSpeed.config.url === 'string') {
      sanitized.tokenSpeed.config.url = sanitizeReportUrl(sanitized.tokenSpeed.config.url);
    }
  }
  return sanitized;
}

/**
 * 生成测试报告
 * @param {Object} results - 测试结果
 * @param {string} outputDir - 输出目录
 * @returns {Promise<Object>} 生成的报告路径
 */
export async function generateReport(results, outputDir = './results') {
  // 确保输出目录存在
  await fs.mkdir(outputDir, { recursive: true });

  // 使用本地时区（UTC+8）生成时间戳
  const reportTime = new Date();
  const now = reportTime;
  const pad = (n) => n.toString().padStart(2, '0');
  const localTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const baseName = `benchmark-${localTimestamp}`;

  // 生成JSON报告
  const jsonPath = await generateJsonReport(results, outputDir, baseName);

  // 生成Markdown报告
  const mdPath = await generateMarkdownReport(results, outputDir, baseName, reportTime);

  // 生成HTML报告
  const htmlPath = await generateHtmlReport(results, outputDir, baseName, reportTime);

  console.log(chalk.cyan('\n📁 报告已生成:'));
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}`);
  console.log(`  HTML: ${htmlPath}`);

  return { jsonPath, mdPath, htmlPath };
}

/**
 * 生成JSON报告
 * @param {Object} results - 测试结果
 * @param {string} outputDir - 输出目录
 * @param {string} baseName - 基础文件名
 * @returns {Promise<string>} 文件路径
 */
async function generateJsonReport(results, outputDir, baseName) {
  const filePath = path.join(outputDir, `${baseName}.json`);
  const payload = redactReportSecrets(
    shouldIncludeOutputText() ? results : stripOutputText(results)
  );
  await fs.writeFile(filePath, JSON.stringify({ metricsVersion: METRICS_VERSION, ...payload }, null, 2));
  return filePath;
}

/**
 * 生成Markdown报告
 * @param {Object} results - 测试结果
 * @param {string} outputDir - 输出目录
 * @param {string} baseName - 基础文件名
 * @returns {Promise<string>} 文件路径
 */
async function generateMarkdownReport(results, outputDir, baseName, reportTime) {
  const lines = [];

  lines.push('# LLM API 性能测试报告');
  lines.push('');
  lines.push(`**测试时间**: ${formatUtc8Timestamp(reportTime)}`);
  lines.push('');

  // Token速度测试结果
  if (results.tokenSpeed && results.tokenSpeed.success) {
    const config = results.tokenSpeed.config;
    const tps = results.tokenSpeed.metrics.tps;
    const tpsSampleCount = getTpsSampleCount(results.tokenSpeed);
    lines.push('## ⚡ Token生成速度测试');
    lines.push('');
    lines.push('### 测试配置');
    lines.push('');
    lines.push('| 参数 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| API URL | ${escapeMarkdownTableCell(sanitizeReportUrl(config.url) || 'N/A')} |`);
    lines.push(`| 模型 | ${escapeMarkdownTableCell(config.model || 'N/A')} |`);
    lines.push(`| 请求超时 | ${config.timeout == null ? 'N/A' : `${config.timeout} ms`} |`);
    lines.push(`| Sample数量（-n） | ${config.sampleCount ?? 0} |`);
    if (config.sampleCount > 0) {
      lines.push(`| Sample说明 | 每次请求随机抽取 ${config.sampleCount} 个样本 |`);
    }
    if (config.bank?.itemCount !== undefined) {
      lines.push(`| 题库 | ${escapeMarkdownTableCell(
        `${config.bank.name} v${config.bank.version}（${config.bank.itemCount} 条，hash ${config.bank.hash}）`
      )} |`);
    }
    lines.push(`| --extra-body | ${config.extraBody && Object.keys(config.extraBody).length > 0
      ? escapeMarkdownTableCell(JSON.stringify(redactSensitiveFields(config.extraBody)))
      : '无'} |`);
    lines.push(`| 最大输出Token数 | ${config.maxOutputTokens} |`);
    lines.push(`| 并发数 | ${config.concurrency} |`);
    lines.push(`| 并发模式 | ${config.concurrencyMode === 'pipeline' ? '流水线' : '批次'} |`);
    lines.push(`| 采样次数 | ${config.samples} |`);
    if (config.cacheProbe) {
      lines.push(`| 缓存探针单元数 | ${config.units?.length ?? 0} |`);
      lines.push(`| 目标前缀Token数 | ${config.prefixTokens ?? 'N/A'} |`);
      lines.push(`| warmupMode | ${escapeMarkdownTableCell(config.warmupMode ?? 'N/A')} |`);
      lines.push(`| runSalt | ${escapeMarkdownTableCell(config.runSalt ?? 'N/A')} |`);
      lines.push(`| 素材库（config.bank） | ${config.bank
        ? escapeMarkdownTableCell(JSON.stringify(config.bank))
        : 'N/A'} |`);
    }
    lines.push('');

    lines.push('### Token生成速度 (TPS)');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    if (shouldCollapseTpsStatistics(tpsSampleCount)) {
      lines.push(`| TPS统计（样本不足，n=${tpsSampleCount}） | ${formatTpsStatistics(tps)} |`);
    } else {
      lines.push(`| 平均 | ${tps.mean.toFixed(2)} tokens/s |`);
      lines.push(`| 中位数 | ${tps.median.toFixed(2)} tokens/s |`);
      lines.push(`| 最小 | ${tps.min.toFixed(2)} tokens/s |`);
      lines.push(`| 最大 | ${tps.max.toFixed(2)} tokens/s |`);
    }
    lines.push(`| 整体吞吐（墙钟） | ${results.tokenSpeed.metrics.throughputTps ? results.tokenSpeed.metrics.throughputTps.toFixed(2) : '-'} tokens/s |`);
    if (shouldShowTpsWarning(results.tokenSpeed)) {
      lines.push('');
      lines.push('> ⚠️ 输出过短，TPS 不具意义');
    }
    lines.push('');

    lines.push('### 首Token延迟');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| TTFT 平均（含推理） | ${results.tokenSpeed.metrics.ttft.mean.toFixed(0)} ms |`);
    lines.push(`| TTFT 中位数（含推理） | ${results.tokenSpeed.metrics.ttft.median.toFixed(0)} ms |`);
    lines.push(`| TTFT 最小（含推理） | ${results.tokenSpeed.metrics.ttft.min.toFixed(0)} ms |`);
    lines.push(`| TTFT 最大（含推理） | ${results.tokenSpeed.metrics.ttft.max.toFixed(0)} ms |`);
    if (results.tokenSpeed.metrics.ttfo?.values?.length > 0) {
      lines.push(`| TTFO 平均（首个可见内容） | ${results.tokenSpeed.metrics.ttfo.mean.toFixed(0)} ms |`);
    }
    lines.push('');
    lines.push('> TTFT 到首个生成 token（含 reasoning）；TTFO 到首个可见内容。');
    lines.push('');

    lines.push('### 输出Token统计');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均 | ${results.tokenSpeed.metrics.outputTokens.mean.toFixed(0)} tokens |`);
    lines.push(`| 中位数 | ${results.tokenSpeed.metrics.outputTokens.median.toFixed(0)} tokens |`);
    if (results.tokenSpeed.metrics.reasoningTokens?.total > 0) {
      lines.push(`| 推理Token 平均 | ${results.tokenSpeed.metrics.reasoningTokens.mean.toFixed(0)} tokens |`);
      lines.push(`| 内容Token 平均 | ${results.tokenSpeed.metrics.contentTokens.mean.toFixed(0)} tokens |`);
    }
    lines.push('');
    if (results.tokenSpeed.metrics.tokenSource) {
      const ts = results.tokenSpeed.metrics.tokenSource;
      lines.push(`> Token 计数来源：服务端 usage ${ts.api} / 客户端 tokenizer 估算 ${ts.tokenizer}`);
      if (ts.api === 0) {
        lines.push('> 服务端未返回 usage，绝对 token 数为客户端 tokenizer 估算值。');
      }
      lines.push('');
    }

    const diagnosticWarnings = getDiagnosticWarnings(results.tokenSpeed.metrics);
    for (const warning of diagnosticWarnings) {
      lines.push(warning);
    }
    if (diagnosticWarnings.length > 0) {
      lines.push('');
    }

    if (results.tokenSpeed.metrics.cache) {
      appendCacheMarkdown(lines, results.tokenSpeed.metrics.cache, results.tokenSpeed.config);
    }
    
    // 错误统计
    if (results.tokenSpeed.errors && results.tokenSpeed.errors.total > 0) {
      lines.push('### ❌ 错误统计');
      lines.push('');
      lines.push('| 指标 | 值 |');
      lines.push('|------|-----|');
      lines.push(`| 失败请求数 | ${results.tokenSpeed.errors.total}/${results.tokenSpeed.config.samples} |`);
      lines.push(`| 错误率 | ${results.tokenSpeed.errors.rate}% |`);
      lines.push(`| 成功请求数 | ${results.tokenSpeed.config.samples - results.tokenSpeed.errors.total} |`);
      lines.push('');
      
      // 错误详情
      if (results.tokenSpeed.errors.details && results.tokenSpeed.errors.details.length > 0) {
        lines.push('**错误详情:**');
        lines.push('');
        for (const detail of results.tokenSpeed.errors.details.slice(0, 10)) {  // 最多显示10个
          lines.push(`- 请求 #${detail.requestIndex + 1}: ${inlineMarkdown(detail.error)}`);
        }
        if (results.tokenSpeed.errors.details.length > 10) {
          lines.push(`- ... 还有 ${results.tokenSpeed.errors.details.length - 10} 个错误`);
        }
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push(`*报告生成时间: ${formatUtc8Timestamp(reportTime)}*`);

  const filePath = path.join(outputDir, `${baseName}.md`);
  await fs.writeFile(filePath, lines.join('\n'));
  return filePath;
}

/**
 * 生成HTML报告
 * @param {Object} results - 测试结果
 * @param {string} outputDir - 输出目录
 * @param {string} baseName - 基础文件名
 * @returns {Promise<string>} 文件路径
 */
async function generateHtmlReport(results, outputDir, baseName, reportTime) {
  // 准备图表数据
  const chartData = prepareChartData(results);
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(results.reportTitle) || 'LLM API 性能测试报告'}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f7fafc; 
      color: #2d3748; 
      line-height: 1.6;
      min-height: 100vh;
    }
    .container { width: 95%; max-width: 1600px; margin: 0 auto; padding: 25px; }
    h1 { 
      color: #2d3748; 
      margin-bottom: 8px; 
      font-size: 1.8rem; 
      font-weight: 600;
    }
    .report-title { 
      color: #3182ce; 
      font-size: 1.3rem; 
      font-weight: 500;
      margin-bottom: 15px;
      padding-bottom: 15px;
      border-bottom: 2px solid #e2e8f0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .report-title::before {
      content: '';
      display: inline-block;
      width: 4px;
      height: 24px;
      background: #4299e1;
      border-radius: 2px;
    }
    h2 { color: #2d3748; margin: 20px 0 12px; font-size: 1.3rem; font-weight: 500; }
    h3 { color: #2d3748; margin: 15px 0 10px; font-size: 1.1rem; font-weight: 500; }
    h4 { color: #4a5568; margin: 10px 0 8px; font-size: 0.95rem; font-weight: 500; }
    .card { 
      background: white; 
      border-radius: 8px; 
      padding: 25px; 
      margin: 20px 0; 
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .card-tokenspeed { 
      border-left: none;
      background: white;
    }
    .config-row { display: flex; gap: 25px; margin-bottom: 20px; }
    .config-table { flex: 1; }
    .config-metrics { flex: 1; }
    table { 
      width: 100%; 
      border-collapse: separate; 
      border-spacing: 0;
      font-size: 13px;
    }
    th, td { 
      padding: 10px 14px; 
      text-align: left; 
      border-bottom: 1px solid #e2e8f0;
    }
    th { 
      background: #f7fafc; 
      color: #4a5568; 
      font-weight: 500;
      font-size: 12px;
    }
    th:first-child { border-radius: 6px 0 0 0; }
    th:last-child { border-radius: 0 6px 0 0; }
    tr:last-child td:first-child { border-radius: 0 0 0 6px; }
    tr:last-child td:last-child { border-radius: 0 0 6px 0; }
    tr:hover { background: #f7fafc; }
    .metric-value { font-size: 24px; font-weight: 600; color: #2d3748; }
    .metric-label { font-size: 11px; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .metric-card { 
      text-align: center; 
      padding: 15px; 
      background: #fff; 
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      transition: all 0.2s;
    }
    .metric-card:hover {
      border-color: #cbd5e0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    .good { color: #38a169; }
    .warning { color: #d69e2e; }
    .bad { color: #e53e3e; }
    .timestamp { 
      color: #718096; 
      font-size: 14px; 
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .timestamp::before {
      content: '📅';
    }
    .chart-container { position: relative; height: 220px; }
    .charts-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
    .chart-card { 
      background: #fff; 
      border-radius: 8px; 
      padding: 15px;
      border: 1px solid #e2e8f0;
      transition: all 0.2s;
    }
    .chart-card:hover {
      border-color: #cbd5e0;
    }
    #timelineChart { background: #f7fafc; border-radius: 6px; }
    .timeline-container { 
      height: 280px; 
      margin: 15px 0;
      background: #f7fafc;
      border-radius: 6px;
      padding: 15px;
      border: 1px solid #e2e8f0;
    }
    .panel {
      animation: fadeIn 0.5s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .panel-1 { animation-delay: 0.1s; }
    .panel-2 { animation-delay: 0.2s; }
    .panel-3 { animation-delay: 0.3s; }
    .diagnostic-warning { color: #9c4221; background: #fffaf0; padding: 8px 10px; border-radius: 4px; margin: 8px 0; font-size: 13px; }
    .sample-note { color: #718096; font-size: 12px; margin: 0 0 10px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 LLM API 性能测试报告</h1>
    ${results.reportTitle ? `
    <div class="report-title">${escapeHtml(results.reportTitle)}</div>
    ` : ''}
    <p class="timestamp">测试时间: ${formatUtc8Timestamp(reportTime)}</p>
    
    ${generateTokenSpeedHtml(results, chartData)}
  </div>
  
  <script>
    ${generateChartScripts(chartData)}
  </script>
</body>
</html>`;

  const filePath = path.join(outputDir, `${baseName}.html`);
  await fs.writeFile(filePath, html);
  return filePath;
}

/**
 * 准备图表数据
 * @param {Object} results - 测试结果
 * @returns {Object} 图表数据
 */
function prepareChartData(results) {
  const chartData = {
    tokenSpeed: null
  };

  // Token速度测试图表数据
  if (results.tokenSpeed && results.tokenSpeed.success) {
    const r = results.tokenSpeed;
    // 对 raw 数组按 requestIndex 排序，确保图表X轴按数字顺序显示
    const raw = (r.raw || []).sort((a, b) =>
      (a.requestIndex !== undefined ? a.requestIndex : 0) - (b.requestIndex !== undefined ? b.requestIndex : 0)
    );
    const failed = r.failed || [];
    
    // 合并成功和失败的请求，用于甘特图
    const allRequests = [...raw, ...failed].sort((a, b) =>
      (a.requestIndex || 0) - (b.requestIndex || 0)
    );
    
    // 计算时间线数据（用于甘特图）- 包含成功和失败的请求
    let timelineData = null;
    if (allRequests.length > 0 && allRequests[0].requestSendTime) {
      const testStartTime = Math.min(...allRequests.map(d => d.requestSendTime));
      
      timelineData = allRequests.map((d, i) => {
        const sendOffset = d.requestSendTime - testStartTime;
        const receiveOffset = d.responseReceiveTime ? d.responseReceiveTime - testStartTime : sendOffset + (d.totalRequestTime || 0);
        const ttft = d.ttft || 0;
        const firstTokenOffset = sendOffset + ttft;
        
        return {
          requestIndex: d.requestIndex !== undefined ? d.requestIndex : i,
          sendOffset,          // 请求发出时间（相对于测试开始）
          firstTokenOffset,    // 首Token时间
          receiveOffset,       // 响应完成时间
          ttft: d.ttft,
          totalRequestTime: d.totalRequestTime || 0,
          tps: d.tps || 0,
          success: d.success,
          error: d.error || null,  // 错误信息
          inputTokens: d.inputTokens || 0,  // 每个请求的实际输入Token数
          outputTokens: d.outputTokens || 0
        };
      });
    }
    
    // 计算输入Token统计（每个请求可能不同）
    const inputTokensArray = raw.map(d => d.inputTokens || 0);
    const inputTokensStats = inputTokensArray.length > 0 ? {
      min: Math.min(...inputTokensArray),
      max: Math.max(...inputTokensArray),
      mean: inputTokensArray.reduce((a, b) => a + b, 0) / inputTokensArray.length
    } : { min: 0, max: 0, mean: 0 };
    
    chartData.tokenSpeed = {
      labels: raw.map((d, i) => `请求 ${(d.requestIndex !== undefined ? d.requestIndex : i) + 1}`),
      tps: raw.map(d => d.tps),
      ttft: raw.map(d => d.ttft),
      outputTokens: raw.map(d => d.outputTokens),
      inputTokens: raw.map(d => d.inputTokens || 0),  // 每个请求的实际输入Token数
      inputTokensStats: inputTokensStats,  // 输入Token统计
      requestTime: raw.map(d => d.totalRequestTime),
      // 时间线数据
      timeline: timelineData,
      testStartTime: raw.length > 0 && raw[0].requestSendTime ? Math.min(...raw.map(d => d.requestSendTime)) : null,
      // 统计数据
      tpsStats: {
        mean: r.metrics.tps.mean,
        median: r.metrics.tps.median,
        min: r.metrics.tps.min,
        max: r.metrics.tps.max
      },
      ttftStats: {
        mean: r.metrics.ttft.mean,
        median: r.metrics.ttft.median,
        min: r.metrics.ttft.min,
        max: r.metrics.ttft.max
      }
    };
  }

  return chartData;
}

/**
 * 生成图表初始化脚本
 * @param {Object} chartData - 图表数据
 * @returns {string} JavaScript代码
 */
function generateChartScripts(chartData) {
  let scripts = '';

  // Token速度图表
  if (chartData.tokenSpeed) {
    const ts = chartData.tokenSpeed;
    
    // 甘特图/时间线数据 - 使用浮动柱状图实现真正的甘特图
    const timelineScript = ts.timeline ? `
    // 请求时间线图（甘特图样式）- 使用水平浮动柱状图
    const timelineCtx = document.getElementById('timelineChart');
    if (timelineCtx) {
      const timelineData = ${jsonForScript(ts.timeline)};
      const maxTime = Math.max(...timelineData.map(d => d.receiveOffset)) / 1000;
      const requestCount = timelineData.length;
      
      // 使用浮动柱状图（水平方向）
      // Chart.js 的 bar chart 默认是垂直的，设置 indexAxis: 'y' 变成水平
      const ttftData = [];   // TTFT阶段数据 [start, end]
      const genData = [];    // Token生成阶段数据 [start, end]
      const failedData = []; // 失败请求数据 [start, end]
      
      // 为每个请求准备数据，区分成功和失败
      const ttftColors = [];   // TTFT阶段颜色
      const genColors = [];    // 生成阶段颜色
      const failedColors = []; // 失败请求颜色
      
      timelineData.forEach((d, idx) => {
        const sendTime = d.sendOffset / 1000;
        const firstTokenTime = d.firstTokenOffset / 1000;
        const receiveTime = d.receiveOffset / 1000;
        
        if (d.success === false) {
          // 失败请求：只显示一个红色条
          ttftData.push([sendTime, receiveTime]);
          genData.push([receiveTime, receiveTime]); // 空数据
          failedData.push([sendTime, receiveTime]);
          
          ttftColors.push('rgba(231, 76, 60, 0.8)');  // 红色
          genColors.push('rgba(231, 76, 60, 0)');
          failedColors.push('rgba(231, 76, 60, 0.8)');
        } else {
          // 成功请求：显示TTFT和生成阶段
          ttftData.push([sendTime, firstTokenTime]);
          genData.push([firstTokenTime, receiveTime]);
          failedData.push([receiveTime, receiveTime]); // 空数据
          
          ttftColors.push('rgba(241, 196, 15, 0.8)');  // 黄色
          genColors.push('rgba(46, 204, 113, 0.8)');   // 绿色
          failedColors.push('rgba(46, 204, 113, 0)');
        }
      });
      
      // 请求标签（从请求1开始）- timelineData 已经按 requestIndex 排序
      const labels = timelineData.map(d => '请求 ' + (d.requestIndex + 1));
      
      new Chart(timelineCtx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: '等待TTFT',
            data: ttftData,
            backgroundColor: ttftColors,
            borderColor: ttftColors.map(c => c.replace('0.8', '1')),
            borderWidth: 1,
            borderSkipped: false,
            barPercentage: 0.7,
            categoryPercentage: 0.8
          }, {
            label: 'Token生成',
            data: genData,
            backgroundColor: genColors,
            borderColor: genColors.map(c => c.replace('0.8', '1')),
            borderWidth: 1,
            borderSkipped: false,
            barPercentage: 0.7,
            categoryPercentage: 0.8
          }, {
            label: '失败请求',
            data: failedData,
            backgroundColor: failedColors,
            borderColor: failedColors.map(c => c.replace('0.8', '1')),
            borderWidth: 1,
            borderSkipped: false,
            barPercentage: 0.7,
            categoryPercentage: 0.8
          }]
        },
        options: {
          indexAxis: 'y',  // 水平柱状图
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              title: { display: true, text: '时间 (秒) - 从测试开始计算' },
              min: 0,
              max: Math.ceil(maxTime),
              ticks: {
                callback: function(value) { return value + 's'; }
              }
            },
            y: {
              stacked: true,  // 关键：启用堆叠让TTFT和生成阶段在同一行
              title: { display: true, text: '请求' },
              grid: {
                display: true,
                color: 'rgba(0,0,0,0.1)'
              }
            }
          },
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: {
                usePointStyle: true,
                padding: 15,
                generateLabels: function(chart) {
                  return [
                    { text: '⏳ 等待TTFT', fillStyle: 'rgba(241, 196, 15, 0.8)', strokeStyle: 'rgba(241, 196, 15, 1)', lineWidth: 1 },
                    { text: '🚀 Token生成', fillStyle: 'rgba(46, 204, 113, 0.8)', strokeStyle: 'rgba(46, 204, 113, 1)', lineWidth: 1 },
                    { text: '❌ 失败请求', fillStyle: 'rgba(231, 76, 60, 0.8)', strokeStyle: 'rgba(231, 76, 60, 1)', lineWidth: 1 }
                  ];
                }
              }
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const d = timelineData[context.dataIndex];
                  if (d.success === false) {
                    return '❌ 失败: ' + (d.error || '未知错误');
                  }
                  const isTtft = context.datasetIndex === 0;
                  const duration = isTtft
                    ? ((d.ttft || 0) / 1000).toFixed(2) + 's (等待TTFT)'
                    : (((d.totalRequestTime - d.ttft) || 0) / 1000).toFixed(2) + 's (Token生成, TPS: ' + (d.tps || 0).toFixed(1) + ')';
                  return (isTtft ? '⏳ ' : '🚀 ') + duration;
                }
              }
            }
          }
        }
      });
    }
    ` : '';
    
    scripts += `
    // TPS分布图 - 使用折线图更适合数据较多时
    const tpsCtx = document.getElementById('tpsChart');
    if (tpsCtx) {
      new Chart(tpsCtx, {
        type: 'line',
        data: {
          labels: ${jsonForScript(ts.labels)},
          datasets: [{
            label: 'TPS (tokens/s)',
            data: ${jsonForScript(ts.tps)},
            borderColor: '#3182ce',
            backgroundColor: 'rgba(49, 130, 206, 0.1)',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#3182ce',
            pointBorderColor: '#fff',
            pointBorderWidth: 1,
            fill: true,
            tension: 0.3
          }, {
            label: '平均值',
            data: Array(${ts.tps.length}).fill(${ts.tpsStats.mean.toFixed(2)}),
            type: 'line',
            borderColor: '#e53e3e',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
            tension: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { 
              beginAtZero: true, 
              title: { display: true, text: 'tokens/s' },
              grid: { color: '#e2e8f0' }
            },
            x: {
              grid: { display: false }
            }
          },
          plugins: {
            legend: {
              position: 'top',
              labels: { usePointStyle: true }
            }
          }
        }
      });
    }

    // TTFT分布图 - 使用折线图更适合数据较多时
    const ttftCtx = document.getElementById('ttftChart');
    if (ttftCtx) {
      new Chart(ttftCtx, {
        type: 'line',
        data: {
          labels: ${jsonForScript(ts.labels)},
          datasets: [{
            label: 'TTFT (ms)',
            data: ${jsonForScript(ts.ttft)},
            borderColor: '#ed8936',
            backgroundColor: 'rgba(237, 137, 54, 0.1)',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#ed8936',
            pointBorderColor: '#fff',
            pointBorderWidth: 1,
            fill: true,
            tension: 0.3
          }, {
            label: '平均值',
            data: Array(${ts.ttft.length}).fill(${ts.ttftStats.mean.toFixed(0)}),
            type: 'line',
            borderColor: '#e53e3e',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
            tension: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { 
              beginAtZero: true, 
              title: { display: true, text: 'ms' },
              grid: { color: '#e2e8f0' }
            },
            x: {
              grid: { display: false }
            }
          },
          plugins: {
            legend: {
              position: 'top',
              labels: { usePointStyle: true }
            }
          }
        }
      });
    }

    // 输入/输出Token分布图（堆叠柱状图）
    const outputCtx = document.getElementById('outputChart');
    if (outputCtx) {
      // 每个请求的实际输入Token数
      const inputTokensArray = ${jsonForScript(ts.inputTokens)};
      
      new Chart(outputCtx, {
        type: 'bar',
        data: {
          labels: ${jsonForScript(ts.labels)},
          datasets: [{
            label: '输出Tokens',
            data: ${jsonForScript(ts.outputTokens)},
            backgroundColor: 'rgba(128, 90, 213, 0.8)',
            borderColor: 'rgba(128, 90, 213, 1)',
            borderWidth: 1
          }, {
            label: '输入Tokens',
            data: inputTokensArray,
            backgroundColor: 'rgba(56, 178, 172, 0.8)',
            borderColor: 'rgba(56, 178, 172, 1)',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { stacked: true },
            y: {
              stacked: true,
              beginAtZero: true,
              title: { display: true, text: 'tokens' }
            }
          },
          plugins: {
            legend: {
              position: 'top'
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const label = context.dataset.label || '';
                  const value = context.parsed.y;
                  return label + ': ' + value.toLocaleString() + ' tokens';
                },
                footer: function(tooltipItems) {
                  const total = tooltipItems.reduce((sum, item) => sum + item.parsed.y, 0);
                  return '总计: ' + total.toLocaleString() + ' tokens';
                }
              }
            }
          }
        }
      });
    }
    
    ${timelineScript}
    `;
  }

  return scripts;
}

/**
 * 生成Token速度测试HTML内容
 * @param {Object} results - 测试结果
 * @param {Object} chartData - 图表数据
 * @returns {string} HTML内容
 */
function generateTokenSpeedHtml(results, chartData) {
  if (!results.tokenSpeed || !results.tokenSpeed.success) return '';
  
  const r = results.tokenSpeed;
  const hasTimeline = chartData.tokenSpeed && chartData.tokenSpeed.timeline;
  
  // 计算总测试时间（用于甘特图显示）
  const totalTimeMs = r.config.totalTime || 0;
  const totalTimeStr = totalTimeMs < 60000
    ? `${(totalTimeMs / 1000).toFixed(1)}秒`
    : `${(totalTimeMs / 60000).toFixed(1)}分钟`;
  
  return `
    <div class="card card-tokenspeed">
      <!-- 指标说明 -->
      <div class="metric-explanation" style="background: #f0f4f8; color: #4a5568; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-size: 13px; line-height: 1.6; border-left: 3px solid #4299e1;">
        <strong style="color: #2d3748;">📖 指标说明：</strong>
        <span style="margin-left: 8px;">
          <b>TTFT</b> = 到首个生成 token（含 reasoning） |
          <b>TTFO</b> = 到首个可见内容 |
          <b>TPS</b> = 每秒生成Token数 (Tokens Per Second)
        </span>
      </div>
      ${getDiagnosticWarnings(r.metrics).map((warning) => (
    `<p class="diagnostic-warning">${escapeHtml(warning)}</p>`
  )).join('')}
      
      <!-- Panel 1: 参数及指标卡片 -->
      <div class="panel panel-1" style="margin-bottom: 25px;">
        <h3 style="color: #2d3748; font-size: 16px; margin-bottom: 15px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; font-weight: 500;">
          <span style="background: #4299e1; color: white; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; margin-right: 10px;">1</span>
          测试配置与核心指标
        </h3>
        <div class="config-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div class="config-table" style="background: #fff; border-radius: 8px; padding: 0; border: 1px solid #e2e8f0;">
            <table style="background: white; border-radius: 6px; overflow: hidden; font-size: 13px;">
              <tr><th style="background: #f7fafc; color: #4a5568; font-weight: 500; border-bottom: 1px solid #e2e8f0;">参数</th><th style="background: #f7fafc; color: #4a5568; font-weight: 500; border-bottom: 1px solid #e2e8f0;">值</th></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">API URL</td><td style="font-size: 11px; word-break: break-all; border-bottom: 1px solid #edf2f7;">${escapeHtml(sanitizeReportUrl(r.config.url)) || 'N/A'}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">模型</td><td style="border-bottom: 1px solid #edf2f7;"><span style="color: #3182ce; font-weight: 500;">${escapeHtml(r.config.model) || 'N/A'}</span></td></tr>
              ${r.config.sampleCount > 0 ? `<tr><td style="border-bottom: 1px solid #edf2f7;">Sample数量</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.sampleCount} 个 (每个约 8k tokens)</td></tr>` : ''}
              ${r.config.bank?.itemCount !== undefined ? `<tr><td style="border-bottom: 1px solid #edf2f7;">题库</td><td style="border-bottom: 1px solid #edf2f7;">${escapeHtml(`${r.config.bank.name} v${r.config.bank.version}（${r.config.bank.itemCount} 条，hash ${r.config.bank.hash}）`)}</td></tr>` : ''}
              <tr><td style="border-bottom: 1px solid #edf2f7;">最大输出Token数</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.maxOutputTokens}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">并发模式</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.concurrencyMode === 'pipeline' ? '流水线' : '批次'}</td></tr>
              <tr><td>总测试时间</td><td><strong style="color: #2d3748;">${totalTimeStr}</strong></td></tr>
            </table>
          </div>
          <div class="config-metrics">
            <div class="grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #3182ce;">${r.metrics.tps.mean.toFixed(1)}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">平均 TPS</div>
                ${shouldShowTpsWarning(r) ? '<p class="diagnostic-warning">⚠️ 输出过短，TPS 不具意义</p>' : ''}
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #38a169;">${r.metrics.throughputTps ? r.metrics.throughputTps.toFixed(1) : '-'}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">整体吞吐 TPS (墙钟)</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #805ad5;">${r.metrics.ttfo && r.metrics.ttfo.values && r.metrics.ttfo.values.length > 0 ? (r.metrics.ttfo.mean / 1000).toFixed(2) : '-'}<span style="font-size: 12px; color: #718096; margin-left: 2px;">s</span></div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">平均 TTFO</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #3182ce;">${(r.metrics.ttft.mean / 1000).toFixed(2)}<span style="font-size: 12px; color: #718096; margin-left: 2px;">s</span></div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">平均 TTFT</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #805ad5;">${(r.metrics.ttft.median / 1000).toFixed(2)}<span style="font-size: 12px; color: #718096; margin-left: 2px;">s</span></div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">TTFT 中位数</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #38a169;">${r.metrics.outputTokens.mean.toFixed(0)}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">平均输出Tokens</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #d69e2e;">${chartData.tokenSpeed && chartData.tokenSpeed.inputTokensStats ? chartData.tokenSpeed.inputTokensStats.mean.toFixed(0) : '-'}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">平均输入Tokens</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #e53e3e;">${r.config.concurrency}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">并发数</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #d69e2e;">${r.config.samples}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">采样次数</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; ${r.errors && r.errors.total > 0 ? 'color: #e53e3e;' : 'color: #38a169;'}">${r.errors && r.errors.total > 0 ? ((r.config.samples - r.errors.total) / r.config.samples * 100).toFixed(1) : '100.0'}<span style="font-size: 12px; color: #718096; margin-left: 2px;">%</span></div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">成功率</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      ${hasTimeline ? `
      <!-- Panel 2: 甘特图 -->
      <div class="panel panel-2" style="margin-bottom: 25px; background: #fff; border-radius: 8px; padding: 20px; border: 1px solid #e2e8f0;">
        <h3 style="color: #2d3748; font-size: 16px; margin-bottom: 15px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; font-weight: 500;">
          <span style="background: #805ad5; color: white; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; margin-right: 10px;">2</span>
          请求时间线（甘特图）
          <span style="margin-left: auto; font-size: 12px; color: #718096; font-weight: normal;">总时长: ${totalTimeStr}</span>
        </h3>
        <p style="color: #718096; font-size: 12px; margin-bottom: 15px; background: #f7fafc; padding: 10px 12px; border-radius: 6px; display: inline-block;">
          <span style="display: inline-block; width: 12px; height: 12px; background: #ecc94b; border-radius: 2px; margin-right: 5px; vertical-align: middle;"></span> 等待TTFT
          <span style="display: inline-block; width: 12px; height: 12px; background: #48bb78; border-radius: 2px; margin-left: 15px; margin-right: 5px; vertical-align: middle;"></span> Token生成
          <span style="display: inline-block; width: 12px; height: 12px; background: #f56565; border-radius: 2px; margin-left: 15px; margin-right: 5px; vertical-align: middle;"></span> 失败请求
        </p>
        <div class="timeline-container" style="height: ${Math.max(250, (r.config.samples) * 28 + 60)}px; background: #f7fafc; border-radius: 6px; padding: 10px; border: 1px solid #e2e8f0;">
          <canvas id="timelineChart"></canvas>
        </div>
      </div>
      ` : ''}
      
      ${chartData.tokenSpeed ? `
      <!-- Panel 3: 3个性能图表 -->
      <div class="panel panel-3">
        <h3 style="color: #2d3748; font-size: 16px; margin-bottom: 15px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; font-weight: 500;">
          <span style="background: #e53e3e; color: white; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; margin-right: 10px;">3</span>
          性能分布图表
        </h3>
        <div class="charts-row" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;">
          <div class="chart-card" style="background: #fff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0; transition: all 0.2s;">
            <h3 style="color: #3182ce; font-size: 14px; margin-bottom: 12px; text-align: center; font-weight: 500;">📊 TPS 分布</h3>
            ${shouldCollapseTpsStatistics(getTpsSampleCount(r)) ? `<p class="sample-note">TPS统计（样本不足，n=${getTpsSampleCount(r)}）：${escapeHtml(formatTpsStatistics(r.metrics.tps))}</p>` : ''}
            <div class="chart-container" style="position: relative; height: 220px;">
              <canvas id="tpsChart"></canvas>
            </div>
          </div>
          <div class="chart-card" style="background: #fff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0; transition: all 0.2s;">
            <h3 style="color: #ed8936; font-size: 14px; margin-bottom: 12px; text-align: center; font-weight: 500;">⏱️ TTFT 分布</h3>
            <div class="chart-container" style="position: relative; height: 220px;">
              <canvas id="ttftChart"></canvas>
            </div>
          </div>
          <div class="chart-card" style="background: #fff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0; transition: all 0.2s;">
            <h3 style="color: #805ad5; font-size: 14px; margin-bottom: 12px; text-align: center; font-weight: 500;">🔄 输入/输出Token分布</h3>
            <div class="chart-container" style="position: relative; height: 220px;">
              <canvas id="outputChart"></canvas>
            </div>
          </div>
        </div>
      </div>
      ` : ''}${r.metrics.cache ? generateCacheHtml(r.metrics.cache, r.config) : ''}
    </div>
  `;
}

export default {
  generateReport
};