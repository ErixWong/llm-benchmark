/**
 * 报告生成器模块
 * 生成测试结果报告
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

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
 * 生成测试报告
 * @param {Object} results - 测试结果
 * @param {string} outputDir - 输出目录
 * @returns {Promise<Object>} 生成的报告路径
 */
export async function generateReport(results, outputDir = './results') {
  const normalizedResults = normalizeReportResults(results);

  // 确保输出目录存在
  await fs.mkdir(outputDir, { recursive: true });

  // 使用本地时区（UTC+8）生成时间戳
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  const localTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const baseName = `benchmark-${localTimestamp}`;

  // 生成JSON报告
  const jsonPath = await generateJsonReport(normalizedResults, outputDir, baseName);

  // 生成Markdown报告
  const mdPath = await generateMarkdownReport(normalizedResults, outputDir, baseName);

  // 生成HTML报告
  const htmlPath = await generateHtmlReport(normalizedResults, outputDir, baseName);

  console.log(chalk.cyan('\n📁 报告已生成:'));
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}`);
  console.log(`  HTML: ${htmlPath}`);

  return { jsonPath, mdPath, htmlPath };
}

function normalizeReportResults(results) {
  if (results?.tokenSpeed) {
    return results;
  }

  if (results?.type === 'token-speed') {
    return {
      ...results,
      tokenSpeed: results,
      reportTitle: results.reportTitle
    };
  }

  return results;
}

function getReportDisplayTime(results) {
  const timestamp = results?.tokenSpeed?.timestamp || results?.timestamp;
  return timestamp ? new Date(timestamp).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN');
}

function formatSecondsFromMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'N/A';
  }

  return `${(value / 1000).toFixed(2)} s`;
}

function getPrimaryTokenSource(results) {
  const tokenSource = results?.tokenSpeed?.raw?.find(item => item?.tokenSource)?.tokenSource;
  return tokenSource || 'unknown';
}

function getFailureSummary(results) {
  const total = results?.tokenSpeed?.errors?.total || 0;
  const rate = results?.tokenSpeed?.errors?.rate || '0.00';
  const hasFailures = total > 0;

  return {
    total,
    rate,
    hasFailures,
    label: hasFailures ? `失败 ${total} 个请求` : '无失败请求'
  };
}

function getReportSummary(results) {
  const tokenSpeed = results?.tokenSpeed;
  if (!tokenSpeed?.success) {
    return '本次测试未成功完成，报告仅包含失败摘要。';
  }

  const tokenSource = getPrimaryTokenSource(results);
  const ttft = formatSecondsFromMs(tokenSpeed.metrics.ttft.mean);
  const tps = `${tokenSpeed.metrics.tps.mean.toFixed(1)} tokens/s`;
  const failureSummary = getFailureSummary(results);
  const failureText = failureSummary.hasFailures ? `，失败 ${failureSummary.total} 个请求` : '，无失败请求';

  return `${tokenSpeed.config.model || '当前模型'} 本次测试的 token 统计来源为 ${tokenSource}，平均 TTFT ${ttft}，加权平均 TPS ${tps}${failureText}。`;
}

function getTokenMetricCards(results) {
  const tokenSpeed = results?.tokenSpeed;
  if (!tokenSpeed?.success) {
    return null;
  }

  return {
    primaryOutputLabel: '服务端输出Tokens',
    primaryOutputValue: tokenSpeed.metrics.outputTokens.mean.toFixed(0),
    secondaryOutputLabel: '可见文本Tokens',
    secondaryOutputValue: tokenSpeed.metrics.visibleOutputTokens.mean.toFixed(0),
    secondaryOutputHint: '本地根据可见 content 估算，仅用于辅助理解'
  };
}

function getInputTokenDisplay(results) {
  const tokenSpeed = results?.tokenSpeed;
  if (!tokenSpeed?.success) {
    return null;
  }

  const configured = tokenSpeed.config?.inputTokens ?? null;
  const actualStats = tokenSpeed.metrics?.inputTokens;
  const actualMean = actualStats?.mean ?? null;
  const actualMin = actualStats?.min ?? null;
  const actualMax = actualStats?.max ?? null;

  const hasMeaningfulDrift = configured !== null && actualMean !== null
    ? Math.abs(configured - actualMean) >= Math.max(5, configured * 0.2)
    : false;

  return {
    configured,
    actualMean,
    actualMin,
    actualMax,
    hasMeaningfulDrift,
    driftHint: hasMeaningfulDrift ? '配置估算与实际请求输入存在明显偏差，请以下方实际统计为准。' : null
  };
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
  await fs.writeFile(filePath, JSON.stringify(results, null, 2));
  return filePath;
}

/**
 * 生成Markdown报告
 * @param {Object} results - 测试结果
 * @param {string} outputDir - 输出目录
 * @param {string} baseName - 基础文件名
 * @returns {Promise<string>} 文件路径
 */
async function generateMarkdownReport(results, outputDir, baseName) {
  const lines = [];

  lines.push('# LLM API 性能测试报告');
  lines.push('');
  lines.push(`**测试时间**: ${getReportDisplayTime(results)}`);
  lines.push('');

  // Token速度测试结果
  if (results.tokenSpeed && results.tokenSpeed.success) {
    lines.push('## ⚡ Token生成速度测试');
    lines.push('');
    lines.push('### 测试配置');
    lines.push('');
    lines.push('| 参数 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 模型 | ${results.tokenSpeed.config.model || 'N/A'} |`);
    if (results.tokenSpeed.config.sampleCount > 0) {
      lines.push(`| Sample数量 | ${results.tokenSpeed.config.sampleCount} 个 (每个约 8k tokens) |`);
    }
    lines.push(`| 最大输出Token数 | ${results.tokenSpeed.config.maxOutputTokens} |`);
    lines.push(`| 并发数 | ${results.tokenSpeed.config.concurrency} |`);
    lines.push(`| 并发模式 | ${results.tokenSpeed.config.concurrencyMode === 'pipeline' ? '流水线' : '批次'} |`);
    lines.push(`| 采样次数 | ${results.tokenSpeed.config.samples} |`);
    lines.push('');

    lines.push('### Token生成速度 (TPS)');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均(加权) | ${results.tokenSpeed.metrics.tps.mean.toFixed(2)} tokens/s |`);
    lines.push(`| 单请求均值 | ${results.tokenSpeed.metrics.tps.requestMean.toFixed(2)} tokens/s |`);
    lines.push(`| 中位数 | ${results.tokenSpeed.metrics.tps.median.toFixed(2)} tokens/s |`);
    lines.push(`| 最小 | ${results.tokenSpeed.metrics.tps.min.toFixed(2)} tokens/s |`);
    lines.push(`| 最大 | ${results.tokenSpeed.metrics.tps.max.toFixed(2)} tokens/s |`);
    lines.push(`| 整体吞吐 | ${results.tokenSpeed.metrics.throughputTps ? results.tokenSpeed.metrics.throughputTps.toFixed(2) : '-'} tokens/s |`);
    lines.push('');

    lines.push('### 首Token延迟 (TTFT)');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均 | ${formatSecondsFromMs(results.tokenSpeed.metrics.ttft.mean)} |`);
    lines.push(`| 中位数 | ${formatSecondsFromMs(results.tokenSpeed.metrics.ttft.median)} |`);
    lines.push(`| 最小 | ${formatSecondsFromMs(results.tokenSpeed.metrics.ttft.min)} |`);
    lines.push(`| 最大 | ${formatSecondsFromMs(results.tokenSpeed.metrics.ttft.max)} |`);
    lines.push('');

    lines.push('### 输出Token统计');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均 | ${results.tokenSpeed.metrics.outputTokens.mean.toFixed(0)} tokens |`);
    lines.push(`| 中位数 | ${results.tokenSpeed.metrics.outputTokens.median.toFixed(0)} tokens |`);
    lines.push('');
    
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
          lines.push(`- 请求 #${detail.requestIndex + 1}: ${detail.error}`);
        }
        if (results.tokenSpeed.errors.details.length > 10) {
          lines.push(`- ... 还有 ${results.tokenSpeed.errors.details.length - 10} 个错误`);
        }
        lines.push('');
      }
    }
  } else if (results.tokenSpeed && results.tokenSpeed.success === false) {
    lines.push('## ❌ Token生成速度测试失败');
    lines.push('');
    lines.push(`- 错误原因: ${results.tokenSpeed.error || '未知错误'}`);
    lines.push(`- 失败请求数: ${results.tokenSpeed.failedCount || 0}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*报告生成时间: ${new Date().toISOString()}*`);

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
async function generateHtmlReport(results, outputDir, baseName) {
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
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 LLM API 性能测试报告</h1>
    ${results.reportTitle ? `
    <div class="report-title">${escapeHtml(results.reportTitle)}</div>
    ` : ''}
    <p class="timestamp">测试时间: ${getReportDisplayTime(results)}</p>
    
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
        const visibleTtft = d.visibleTtft || ttft;
        const firstTokenOffset = sendOffset + ttft;
        const firstVisibleTokenOffset = sendOffset + visibleTtft;
        
        return {
          requestIndex: d.requestIndex !== undefined ? d.requestIndex : i,
          sendOffset,          // 请求发出时间（相对于测试开始）
          firstTokenOffset,    // 首Token时间
          firstVisibleTokenOffset,
          receiveOffset,       // 响应完成时间
          ttft: d.ttft,
          visibleTtft: d.visibleTtft,
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
      labels: allRequests.map((_, i) => `请求 ${i + 1}`),
      tps: allRequests.map(d => d.success === false ? null : d.tps),
      ttft: allRequests.map(d => d.success === false ? null : d.ttft),
      outputTokens: allRequests.map(d => d.success === false ? null : d.outputTokens),
      inputTokens: allRequests.map(d => d.success === false ? null : (d.inputTokens || 0)),  // 每个请求的实际输入Token数
      inputTokensStats: inputTokensStats,  // 输入Token统计
      requestTime: allRequests.map(d => d.totalRequestTime || null),
      // 时间线数据
      timeline: timelineData,
      testStartTime: raw.length > 0 && raw[0].requestSendTime ? Math.min(...raw.map(d => d.requestSendTime)) : null,
      // 统计数据
      tpsStats: {
        mean: r.metrics.tps.mean,
        requestMean: r.metrics.tps.requestMean,
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
      const timelineData = ${JSON.stringify(ts.timeline)};
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
          labels: ${JSON.stringify(ts.labels)},
          datasets: [{
            label: 'TPS (tokens/s)',
            data: ${JSON.stringify(ts.tps)},
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
            label: '加权平均值',
            data: Array(${ts.tps.length}).fill(${ts.tpsStats.mean.toFixed(2)}),
            type: 'line',
            borderColor: '#e53e3e',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
            tension: 0
          }, {
            label: '单请求均值',
            data: Array(${ts.tps.length}).fill(${ts.tpsStats.requestMean.toFixed(2)}),
            type: 'line',
            borderColor: '#38a169',
            borderWidth: 2,
            borderDash: [3, 3],
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
          labels: ${JSON.stringify(ts.labels)},
          datasets: [{
            label: 'TTFT (ms)',
            data: ${JSON.stringify(ts.ttft)},
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
      const inputTokensArray = ${JSON.stringify(ts.inputTokens)};
      
      new Chart(outputCtx, {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(ts.labels)},
          datasets: [{
            label: '输出Tokens',
            data: ${JSON.stringify(ts.outputTokens)},
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
  const tokenSource = getPrimaryTokenSource(results);
  const failureSummary = getFailureSummary(results);
  const summaryText = getReportSummary(results);
  const tokenMetricCards = getTokenMetricCards(results);
  const inputTokenDisplay = getInputTokenDisplay(results);
  
  // 计算总测试时间（用于甘特图显示）
  const totalTimeMs = r.config.totalTime || 0;
  const totalTimeStr = totalTimeMs < 60000
    ? `${(totalTimeMs / 1000).toFixed(1)}秒`
    : `${(totalTimeMs / 60000).toFixed(1)}分钟`;
  
  return `
    <div class="card card-tokenspeed">
      <div class="report-overview" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 20px; padding: 16px 18px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;">
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 12px; font-weight: 600; color: #4a5568; margin-bottom: 8px; text-transform: uppercase;">结论摘要</div>
          <div style="font-size: 14px; color: #2d3748; line-height: 1.7;">${escapeHtml(summaryText)}</div>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; max-width: 340px;">
          <span style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: #ebf8ff; color: #2b6cb0; font-size: 12px; font-weight: 600;">Token来源: ${escapeHtml(tokenSource)}</span>
          <span style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: ${failureSummary.hasFailures ? '#fff5f5' : '#f0fff4'}; color: ${failureSummary.hasFailures ? '#c53030' : '#2f855a'}; font-size: 12px; font-weight: 600;">${escapeHtml(failureSummary.label)}</span>
        </div>
      </div>

      <!-- 指标说明 -->
      <div class="metric-explanation" style="background: #f0f4f8; color: #4a5568; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-size: 13px; line-height: 1.6; border-left: 3px solid #4299e1;">
        <strong style="color: #2d3748;">📖 指标说明：</strong>
        <span style="margin-left: 8px;">
          <b>TTFT</b> = 首个生成 token 延迟 |
          <b>TPS</b> = 每秒生成Token数 |
          <b>服务端输出Tokens</b> = 服务端返回的 token 统计 |
          <b>可见文本Tokens</b> = 本地根据可见 content 估算
        </span>
      </div>
      
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
              <tr><td style="border-bottom: 1px solid #edf2f7;">API URL</td><td style="font-size: 11px; word-break: break-all; border-bottom: 1px solid #edf2f7;">${r.config.url || 'N/A'}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">模型</td><td style="border-bottom: 1px solid #edf2f7;"><span style="color: #3182ce; font-weight: 500;">${r.config.model || 'N/A'}</span></td></tr>
              ${r.config.sampleCount > 0 ? `<tr><td style="border-bottom: 1px solid #edf2f7;">Sample数量</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.sampleCount} 个 (每个约 8k tokens)</td></tr>` : ''}
              <tr><td style="border-bottom: 1px solid #edf2f7;">并发数</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.concurrency}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">采样次数</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.samples}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">Token统计来源</td><td style="border-bottom: 1px solid #edf2f7;">${escapeHtml(tokenSource)}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">配置估算输入Tokens</td><td style="border-bottom: 1px solid #edf2f7;">${inputTokenDisplay?.configured ?? 'N/A'}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">实际请求输入Tokens（均值）</td><td style="border-bottom: 1px solid #edf2f7;">${inputTokenDisplay?.actualMean !== null && inputTokenDisplay?.actualMean !== undefined ? inputTokenDisplay.actualMean.toFixed(0) : 'N/A'}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">实际请求输入Tokens（范围）</td><td style="border-bottom: 1px solid #edf2f7;">${inputTokenDisplay?.actualMin !== null && inputTokenDisplay?.actualMax !== null ? `${inputTokenDisplay.actualMin.toFixed(0)} ~ ${inputTokenDisplay.actualMax.toFixed(0)}` : 'N/A'}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">最大输出Token数</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.maxOutputTokens}</td></tr>
              <tr><td style="border-bottom: 1px solid #edf2f7;">并发模式</td><td style="border-bottom: 1px solid #edf2f7;">${r.config.concurrencyMode === 'pipeline' ? '流水线' : '批次'}</td></tr>
              <tr><td>总测试时间</td><td><strong style="color: #2d3748;">${totalTimeStr}</strong></td></tr>
            </table>
            ${inputTokenDisplay?.driftHint ? `<div style="padding: 10px 12px; border-top: 1px solid #edf2f7; font-size: 12px; line-height: 1.6; color: #9c4221; background: #fffaf0;">${inputTokenDisplay.driftHint}</div>` : ''}
          </div>
          <div class="config-metrics">
            <div class="grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;">
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #3182ce;">${r.metrics.tps.mean.toFixed(1)}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">加权平均 TPS</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #38a169;">${r.metrics.throughputTps ? r.metrics.throughputTps.toFixed(1) : '-'}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">整体吞吐 TPS</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #3182ce;">${(r.metrics.ttft.mean / 1000).toFixed(2)}<span style="font-size: 12px; color: #718096; margin-left: 2px;">s</span></div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">首生成Token TTFT</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: ${failureSummary.hasFailures ? '#e53e3e' : '#38a169'};">${failureSummary.hasFailures ? failureSummary.total : 0}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">失败请求</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #805ad5;">${(r.metrics.visibleTtft.mean / 1000).toFixed(2)}<span style="font-size: 12px; color: #718096; margin-left: 2px;">s</span></div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">首可见Token TTFT</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #38a169;">${tokenMetricCards.primaryOutputValue}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${tokenMetricCards.primaryOutputLabel}</div>
              </div>
              <div class="metric-card" style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 12px; text-align: center; transition: all 0.2s;">
                <div class="metric-value" style="font-size: 24px; font-weight: 600; color: #d69e2e;">${tokenMetricCards.secondaryOutputValue}</div>
                <div class="metric-label" style="font-size: 11px; color: #718096; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${tokenMetricCards.secondaryOutputLabel}</div>
                <div style="margin-top: 6px; font-size: 11px; color: #718096; line-height: 1.4;">${tokenMetricCards.secondaryOutputHint}</div>
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
            <h4 style="color: #3182ce; font-size: 14px; margin-bottom: 12px; text-align: center; font-weight: 500;">📊 每请求生成速度</h4>
            <div class="chart-container" style="position: relative; height: 220px;">
              <canvas id="tpsChart"></canvas>
            </div>
          </div>
          <div class="chart-card" style="background: #fff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0; transition: all 0.2s;">
            <h4 style="color: #ed8936; font-size: 14px; margin-bottom: 12px; text-align: center; font-weight: 500;">⏱️ 每请求首Token延迟</h4>
            <div class="chart-container" style="position: relative; height: 220px;">
              <canvas id="ttftChart"></canvas>
            </div>
          </div>
          <div class="chart-card" style="background: #fff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0; transition: all 0.2s;">
            <h4 style="color: #805ad5; font-size: 14px; margin-bottom: 12px; text-align: center; font-weight: 500;">🔄 输入与输出规模对比</h4>
            <div class="chart-container" style="position: relative; height: 220px;">
              <canvas id="outputChart"></canvas>
            </div>
          </div>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

export default {
  generateReport
};

export {
  normalizeReportResults,
  prepareChartData,
  getReportDisplayTime,
  formatSecondsFromMs,
  getPrimaryTokenSource,
  getFailureSummary,
  getReportSummary,
  getTokenMetricCards,
  getInputTokenDisplay
};
