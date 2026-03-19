/**
 * 报告生成器模块
 * 生成测试结果报告
 */

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

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
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  const localTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const baseName = `benchmark-${localTimestamp}`;

  // 生成JSON报告
  const jsonPath = await generateJsonReport(results, outputDir, baseName);

  // 生成Markdown报告
  const mdPath = await generateMarkdownReport(results, outputDir, baseName);

  // 生成HTML报告
  const htmlPath = await generateHtmlReport(results, outputDir, baseName);

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
  lines.push(`**测试时间**: ${new Date().toLocaleString('zh-CN')}`);
  lines.push('');

  // 并发测试结果
  if (results.concurrency) {
    lines.push('## 📊 并发能力测试');
    lines.push('');
    lines.push('### 测试配置');
    lines.push('');
    lines.push('| 参数 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| API URL | ${results.concurrency.config.url || 'N/A'} |`);
    lines.push(`| 模型 | ${results.concurrency.config.model || 'N/A'} |`);
    lines.push(`| 并发数 | ${results.concurrency.config.concurrency} |`);
    lines.push(`| 持续时间 | ${results.concurrency.config.duration.toFixed(2)}s |`);
    lines.push('');

    lines.push('### 吞吐量');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均 RPS | ${results.concurrency.metrics.throughput.rps.toFixed(2)} req/s |`);
    lines.push(`| 最大 RPS | ${results.concurrency.metrics.throughput.maxRps.toFixed(2)} req/s |`);
    lines.push(`| 总请求数 | ${results.concurrency.metrics.throughput.total} |`);
    lines.push(`| 成功请求 | ${results.concurrency.metrics.throughput.success} |`);
    lines.push(`| 成功率 | ${(results.concurrency.metrics.throughput.total > 0 ? (results.concurrency.metrics.throughput.success / results.concurrency.metrics.throughput.total * 100) : 0).toFixed(2)}% |`);
    lines.push('');

    lines.push('### 响应时间');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均 | ${formatLatency(results.concurrency.metrics.latency.mean)} |`);
    lines.push(`| 最小 | ${formatLatency(results.concurrency.metrics.latency.min)} |`);
    lines.push(`| 最大 | ${formatLatency(results.concurrency.metrics.latency.max)} |`);
    lines.push(`| P50 | ${formatLatency(results.concurrency.metrics.latency.p50)} |`);
    lines.push(`| P75 | ${formatLatency(results.concurrency.metrics.latency.p75)} |`);
    lines.push(`| P90 | ${formatLatency(results.concurrency.metrics.latency.p90)} |`);
    lines.push(`| P99 | ${formatLatency(results.concurrency.metrics.latency.p99)} |`);
    lines.push('');

    lines.push('### 错误统计');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 错误率 | ${results.concurrency.metrics.errors.rate.toFixed(2)}% |`);
    lines.push(`| 总错误 | ${results.concurrency.metrics.errors.total} |`);
    lines.push(`| 网络错误 | ${results.concurrency.metrics.errors.networkErrors} |`);
    lines.push(`| 超时 | ${results.concurrency.metrics.errors.timeouts} |`);
    lines.push(`| HTTP错误 | ${results.concurrency.metrics.errors.httpErrors} |`);
    
    // HTTP错误详情
    if (results.concurrency.metrics.errors.details && results.concurrency.metrics.errors.details.length > 0) {
      lines.push('');
      lines.push('**HTTP错误详情:**');
      for (const detail of results.concurrency.metrics.errors.details) {
        lines.push(`- ${detail.code} (${detail.category}): ${detail.count} 次`);
      }
    }
    lines.push('');
  }

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
    lines.push(`| 平均 | ${results.tokenSpeed.metrics.tps.mean.toFixed(2)} tokens/s |`);
    lines.push(`| 中位数 | ${results.tokenSpeed.metrics.tps.median.toFixed(2)} tokens/s |`);
    lines.push(`| 最小 | ${results.tokenSpeed.metrics.tps.min.toFixed(2)} tokens/s |`);
    lines.push(`| 最大 | ${results.tokenSpeed.metrics.tps.max.toFixed(2)} tokens/s |`);
    lines.push(`| 整体吞吐 | ${results.tokenSpeed.metrics.throughputTps ? results.tokenSpeed.metrics.throughputTps.toFixed(2) : '-'} tokens/s |`);
    lines.push('');

    lines.push('### 首Token延迟 (TTFT)');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均 | ${results.tokenSpeed.metrics.ttft.mean.toFixed(0)} ms |`);
    lines.push(`| 中位数 | ${results.tokenSpeed.metrics.ttft.median.toFixed(0)} ms |`);
    lines.push(`| 最小 | ${results.tokenSpeed.metrics.ttft.min.toFixed(0)} ms |`);
    lines.push(`| 最大 | ${results.tokenSpeed.metrics.ttft.max.toFixed(0)} ms |`);
    lines.push('');

    lines.push('### 输出Token统计');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('|------|-----|');
    lines.push(`| 平均 | ${results.tokenSpeed.metrics.outputTokens.mean.toFixed(0)} tokens |`);
    lines.push(`| 中位数 | ${results.tokenSpeed.metrics.outputTokens.median.toFixed(0)} tokens |`);
    lines.push('');
  }

  // 性能评估
  lines.push('## 📈 性能评估');
  lines.push('');
  lines.push(generatePerformanceAssessment(results));
  lines.push('');

  // 结论
  lines.push('## 📝 结论');
  lines.push('');
  lines.push(generateConclusion(results));
  lines.push('');

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
  <title>LLM API 性能测试报告</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5; color: #333; line-height: 1.6;
    }
    .container { width: 90%; max-width: 1800px; margin: 0 auto; padding: 15px; }
    h1 { color: #2c3e50; margin-bottom: 10px; font-size: 1.5rem; }
    h2 { color: #34495e; margin: 15px 0 10px; font-size: 1.2rem; }
    h3 { color: #7f8c8d; margin: 10px 0 5px; font-size: 1rem; }
    .card { background: white; border-radius: 8px; padding: 15px; margin: 10px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .config-row { display: flex; gap: 20px; margin-bottom: 15px; }
    .config-table { flex: 1; }
    .config-metrics { flex: 1; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
    th { background: #3498db; color: white; }
    tr:hover { background: #f8f9fa; }
    .metric-value { font-size: 20px; font-weight: bold; color: #3498db; }
    .metric-label { font-size: 11px; color: #7f8c8d; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
    .metric-card { text-align: center; padding: 12px; background: #f8f9fa; border-radius: 6px; }
    .good { color: #27ae60; }
    .warning { color: #f39c12; }
    .bad { color: #e74c3c; }
    .timestamp { color: #7f8c8d; font-size: 13px; margin-bottom: 10px; }
    .chart-container { position: relative; height: 220px; }
    .charts-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; }
    .chart-card { background: #fafafa; border-radius: 6px; padding: 10px; }
    #timelineChart { background: #fafafa; border-radius: 6px; }
    .timeline-container { height: 280px; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 LLM API 性能测试报告</h1>
    <p class="timestamp">测试时间: ${new Date().toLocaleString('zh-CN')}</p>
    
    ${generateConcurrencyHtml(results)}
    ${generateTokenSpeedHtml(results, chartData)}
    
    <div class="card">
      <h2>📝 结论</h2>
      <p style="font-size: 13px;">${generateConclusion(results)}</p>
    </div>
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
    tokenSpeed: null,
    concurrency: null
  };

  // Token速度测试图表数据
  if (results.tokenSpeed && results.tokenSpeed.success) {
    const r = results.tokenSpeed;
    const raw = r.raw || [];
    
    // 计算时间线数据（用于甘特图）
    let timelineData = null;
    if (raw.length > 0 && raw[0].requestSendTime) {
      const testStartTime = Math.min(...raw.map(d => d.requestSendTime));
      
      timelineData = raw.map((d, i) => {
        const sendOffset = d.requestSendTime - testStartTime;
        const receiveOffset = d.responseReceiveTime ? d.responseReceiveTime - testStartTime : sendOffset + d.totalRequestTime;
        const ttft = d.ttft || 0;
        const firstTokenOffset = sendOffset + ttft;
        
        return {
          requestIndex: d.requestIndex !== undefined ? d.requestIndex : i,
          sendOffset,          // 请求发出时间（相对于测试开始）
          firstTokenOffset,    // 首Token时间
          receiveOffset,       // 响应完成时间
          ttft: d.ttft,
          totalRequestTime: d.totalRequestTime,
          tps: d.tps,
          success: d.success,
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
      inputTokens: inputTokensArray,  // 每个请求的实际输入Token数
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

  // 并发测试图表数据
  if (results.concurrency) {
    const r = results.concurrency;
    chartData.concurrency = {
      latency: {
        p50: r.metrics.latency.p50,
        p75: r.metrics.latency.p75,
        p90: r.metrics.latency.p90,
        p99: r.metrics.latency.p99
      },
      throughput: {
        rps: r.metrics.throughput.rps,
        maxRps: r.metrics.throughput.maxRps
      },
      errors: {
        rate: r.metrics.errors.rate,
        total: r.metrics.errors.total,
        networkErrors: r.metrics.errors.networkErrors,
        timeouts: r.metrics.errors.timeouts,
        httpErrors: r.metrics.errors.httpErrors
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
      
      timelineData.forEach((d, idx) => {
        const sendTime = d.sendOffset / 1000;
        const firstTokenTime = d.firstTokenOffset / 1000;
        const receiveTime = d.receiveOffset / 1000;
        
        // 浮动柱状图需要 [start, end] 格式
        ttftData.push([sendTime, firstTokenTime]);
        genData.push([firstTokenTime, receiveTime]);
      });
      
      // 请求标签（从请求1开始）
      const labels = timelineData.map((d, i) => '请求 ' + (d.requestIndex + 1));
      
      new Chart(timelineCtx, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: '等待TTFT',
            data: ttftData,
            backgroundColor: 'rgba(241, 196, 15, 0.8)',
            borderColor: 'rgba(241, 196, 15, 1)',
            borderWidth: 1,
            borderSkipped: false
          }, {
            label: 'Token生成',
            data: genData,
            backgroundColor: 'rgba(46, 204, 113, 0.8)',
            borderColor: 'rgba(46, 204, 113, 1)',
            borderWidth: 1,
            borderSkipped: false
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
              stacked: true,
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
              position: 'top'
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const d = timelineData[context.dataIndex];
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
    // TPS分布图
    const tpsCtx = document.getElementById('tpsChart');
    if (tpsCtx) {
      new Chart(tpsCtx, {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(ts.labels)},
          datasets: [{
            label: 'TPS (tokens/s)',
            data: ${JSON.stringify(ts.tps)},
            backgroundColor: 'rgba(52, 152, 219, 0.6)',
            borderColor: 'rgba(52, 152, 219, 1)',
            borderWidth: 1
          }, {
            label: '平均值',
            data: Array(${ts.tps.length}).fill(${ts.tpsStats.mean.toFixed(2)}),
            type: 'line',
            borderColor: 'rgba(231, 76, 60, 1)',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'tokens/s' } }
          }
        }
      });
    }

    // TTFT分布图
    const ttftCtx = document.getElementById('ttftChart');
    if (ttftCtx) {
      new Chart(ttftCtx, {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(ts.labels)},
          datasets: [{
            label: 'TTFT (ms)',
            data: ${JSON.stringify(ts.ttft)},
            backgroundColor: 'rgba(46, 204, 113, 0.6)',
            borderColor: 'rgba(46, 204, 113, 1)',
            borderWidth: 1
          }, {
            label: '平均值',
            data: Array(${ts.ttft.length}).fill(${ts.ttftStats.mean.toFixed(0)}),
            type: 'line',
            borderColor: 'rgba(231, 76, 60, 1)',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'ms' } }
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
            backgroundColor: 'rgba(46, 204, 113, 0.8)',
            borderColor: 'rgba(46, 204, 113, 1)',
            borderWidth: 1
          }, {
            label: '输入Tokens',
            data: inputTokensArray,
            backgroundColor: 'rgba(241, 196, 15, 0.8)',
            borderColor: 'rgba(241, 196, 15, 1)',
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

  // 并发测试图表
  if (chartData.concurrency) {
    const c = chartData.concurrency;
    scripts += `
    // 延迟分布图
    const latencyCtx = document.getElementById('latencyChart');
    if (latencyCtx) {
      new Chart(latencyCtx, {
        type: 'bar',
        data: {
          labels: ['P50', 'P75', 'P90', 'P99'],
          datasets: [{
            label: '延迟 (ms)',
            data: [${c.latency.p50.toFixed(0)}, ${c.latency.p75.toFixed(0)}, ${c.latency.p90.toFixed(0)}, ${c.latency.p99.toFixed(0)}],
            backgroundColor: [
              'rgba(46, 204, 113, 0.6)',
              'rgba(52, 152, 219, 0.6)',
              'rgba(241, 196, 15, 0.6)',
              'rgba(231, 76, 60, 0.6)'
            ],
            borderColor: [
              'rgba(46, 204, 113, 1)',
              'rgba(52, 152, 219, 1)',
              'rgba(241, 196, 15, 1)',
              'rgba(231, 76, 60, 1)'
            ],
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'ms' } }
          }
        }
      });
    }

    // 错误分布图
    const errorCtx = document.getElementById('errorChart');
    if (errorCtx) {
      new Chart(errorCtx, {
        type: 'doughnut',
        data: {
          labels: ['网络错误', '超时', 'HTTP错误'],
          datasets: [{
            data: [${c.errors.networkErrors}, ${c.errors.timeouts}, ${c.errors.httpErrors}],
            backgroundColor: [
              'rgba(231, 76, 60, 0.6)',
              'rgba(241, 196, 15, 0.6)',
              'rgba(155, 89, 182, 0.6)'
            ],
            borderColor: [
              'rgba(231, 76, 60, 1)',
              'rgba(241, 196, 15, 1)',
              'rgba(155, 89, 182, 1)'
            ],
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }
    `;
  }

  return scripts;
}

/**
 * 生成并发测试HTML内容
 * @param {Object} results - 测试结果
 * @returns {string} HTML内容
 */
function generateConcurrencyHtml(results) {
  if (!results.concurrency) return '';
  
  const r = results.concurrency;
  return `
    <div class="card">
      <h2>📊 并发能力测试</h2>
      <h3>测试配置</h3>
      <table>
        <tr><th>参数</th><th>值</th></tr>
        <tr><td>API URL</td><td>${r.config.url || 'N/A'}</td></tr>
        <tr><td>模型</td><td>${r.config.model || 'N/A'}</td></tr>
        <tr><td>并发数</td><td>${r.config.concurrency}</td></tr>
        <tr><td>持续时间</td><td>${r.config.duration.toFixed(2)}s</td></tr>
      </table>
      
      <div class="grid">
        <div class="metric-card">
          <div class="metric-value">${r.metrics.throughput.rps.toFixed(1)}</div>
          <div class="metric-label">平均 RPS</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${r.metrics.latency.p90.toFixed(0)}ms</div>
          <div class="metric-label">P90 响应时间</div>
        </div>
        <div class="metric-card">
          <div class="metric-value ${r.metrics.errors.rate < 1 ? 'good' : r.metrics.errors.rate < 5 ? 'warning' : 'bad'}">${r.metrics.errors.rate.toFixed(2)}%</div>
          <div class="metric-label">错误率</div>
        </div>
        <div class="metric-card">
          <div class="metric-value">${r.metrics.throughput.total}</div>
          <div class="metric-label">总请求数</div>
        </div>
      </div>
      
      <div class="charts-row">
        <div class="chart-card">
          <h3>延迟分布</h3>
          <div class="chart-container">
            <canvas id="latencyChart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <h3>错误分布</h3>
          <div class="chart-container">
            <canvas id="errorChart"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;
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
    <div class="card">
      <h2>⚡ Token生成速度测试</h2>
      
      <div class="config-row">
        <div class="config-table">
          <table>
            <tr><th>参数</th><th>值</th></tr>
            <tr><td>模型</td><td>${r.config.model || 'N/A'}</td></tr>
            ${r.config.sampleCount > 0 ? `<tr><td>Sample数量</td><td>${r.config.sampleCount} 个 (每个约 8k tokens)</td></tr>` : ''}
            <tr><td>最大输出Token数</td><td>${r.config.maxOutputTokens}</td></tr>
            <tr><td>并发数</td><td>${r.config.concurrency}</td></tr>
            <tr><td>并发模式</td><td>${r.config.concurrencyMode === 'pipeline' ? '流水线' : '批次'}</td></tr>
            <tr><td>采样次数</td><td>${r.config.samples}</td></tr>
            <tr><td>总测试时间</td><td>${totalTimeStr}</td></tr>
          </table>
        </div>
        <div class="config-metrics">
          <div class="grid" style="grid-template-columns: repeat(2, 1fr);">
            <div class="metric-card">
              <div class="metric-value ${r.metrics.tps.mean >= 50 ? 'good' : r.metrics.tps.mean >= 20 ? 'warning' : 'bad'}">${r.metrics.tps.mean.toFixed(1)}</div>
              <div class="metric-label">平均 TPS</div>
            </div>
            <div class="metric-card">
              <div class="metric-value ${r.metrics.throughputTps && r.metrics.throughputTps >= 100 ? 'good' : r.metrics.throughputTps && r.metrics.throughputTps >= 50 ? 'warning' : 'bad'}">${r.metrics.throughputTps ? r.metrics.throughputTps.toFixed(1) : '-'}</div>
              <div class="metric-label">整体吞吐 TPS</div>
            </div>
            <div class="metric-card">
              <div class="metric-value ${r.metrics.ttft.mean < 500 ? 'good' : r.metrics.ttft.mean < 2000 ? 'warning' : 'bad'}">${r.metrics.ttft.mean.toFixed(0)}ms</div>
              <div class="metric-label">平均 TTFT</div>
            </div>
            <div class="metric-card">
              <div class="metric-value">${r.metrics.outputTokens.mean.toFixed(0)}</div>
              <div class="metric-label">平均输出Tokens</div>
            </div>
          </div>
          <!-- 性能评估放在指标下方 -->
          <div style="margin-top: 15px; padding: 12px; background: #f8f9fa; border-radius: 6px; border-left: 4px solid #3498db;">
            <h4 style="margin: 0 0 8px 0; color: #2c3e50; font-size: 13px;">📈 性能评估</h4>
            <p style="font-size: 12px; margin: 0; line-height: 1.8;">${generatePerformanceAssessment(results)}</p>
          </div>
        </div>
      </div>
      
      ${hasTimeline ? `
      <h3>📊 请求时间线（甘特图）- 总时长: ${totalTimeStr}</h3>
      <p style="color: #7f8c8d; font-size: 12px; margin-bottom: 5px;">
        展示每个请求的时间分布：🟡 等待TTFT | 🟢 Token生成
      </p>
      <div class="timeline-container" style="height: ${Math.max(200, r.config.samples * 25 + 80)}px;">
        <canvas id="timelineChart"></canvas>
      </div>
      ` : ''}
      
      ${chartData.tokenSpeed ? `
      <h3>📈 性能图表</h3>
      <div class="charts-row">
        <div class="chart-card">
          <h4>TPS 分布</h4>
          <div class="chart-container">
            <canvas id="tpsChart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <h4>TTFT 分布</h4>
          <div class="chart-container">
            <canvas id="ttftChart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <h4>输入/输出Token分布</h4>
          <div class="chart-container">
            <canvas id="outputChart"></canvas>
          </div>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

/**
 * 生成性能评估
 * @param {Object} results - 测试结果
 * @returns {string} 评估文本
 */
function generatePerformanceAssessment(results) {
  const assessments = [];

  if (results.concurrency) {
    const r = results.concurrency;
    
    // 吞吐量评估
    if (r.metrics.throughput.rps >= 100) {
      assessments.push('✅ 吞吐量表现优秀，系统具有良好的并发处理能力。');
    } else if (r.metrics.throughput.rps >= 50) {
      assessments.push('✓ 吞吐量表现良好，能够满足一般业务需求。');
    } else {
      assessments.push('⚠️ 吞吐量较低，建议检查系统瓶颈。');
    }

    // 响应时间评估
    if (r.metrics.latency.p90 < 500) {
      assessments.push('✅ 响应时间优秀，用户体验良好。');
    } else if (r.metrics.latency.p90 < 1000) {
      assessments.push('✓ 响应时间可接受，大部分请求能够快速响应。');
    } else {
      assessments.push('⚠️ 响应时间较长，可能影响用户体验。');
    }

    // 错误率评估
    if (r.metrics.errors.rate < 0.1) {
      assessments.push('✅ 错误率极低，系统稳定性优秀。');
    } else if (r.metrics.errors.rate < 1) {
      assessments.push('✓ 错误率可接受，系统稳定性良好。');
    } else {
      assessments.push('⚠️ 错误率偏高，需要排查问题。');
    }
  }

  if (results.tokenSpeed && results.tokenSpeed.success) {
    const r = results.tokenSpeed;

    // TPS评估
    if (r.metrics.tps.mean >= 50) {
      assessments.push('✅ Token生成速度快，适合实时交互场景。');
    } else if (r.metrics.tps.mean >= 20) {
      assessments.push('✓ Token生成速度适中，能够满足一般需求。');
    } else {
      assessments.push('⚠️ Token生成速度较慢，可能影响用户体验。');
    }

    // TTFT评估
    if (r.metrics.ttft.mean < 300) {
      assessments.push('✅ 首Token延迟低，响应迅速。');
    } else if (r.metrics.ttft.mean < 1000) {
      assessments.push('✓ 首Token延迟可接受。');
    } else {
      assessments.push('⚠️ 首Token延迟较高，用户可能感觉到明显等待。');
    }
  }

  return assessments.join('\n\n');
}

/**
 * 生成结论
 * @param {Object} results - 测试结果
 * @returns {string} 结论文本
 */
function generateConclusion(results) {
  const conclusions = [];

  if (results.concurrency) {
    const rps = results.concurrency.metrics.throughput.rps;
    const latency = results.concurrency.metrics.latency.p90;
    const errors = results.concurrency.metrics.errors.rate;

    if (rps >= 50 && latency < 1000 && errors < 1) {
      conclusions.push('并发能力测试结果显示系统性能良好，能够处理预期的负载。');
    } else if (rps >= 20 && latency < 2000 && errors < 5) {
      conclusions.push('并发能力测试结果显示系统性能可接受，但仍有优化空间。');
    } else {
      conclusions.push('并发能力测试结果显示系统存在性能问题，建议进行优化。');
    }
  }

  if (results.tokenSpeed && results.tokenSpeed.success) {
    const tps = results.tokenSpeed.metrics.tps.mean;
    const ttft = results.tokenSpeed.metrics.ttft.mean;

    if (tps >= 30 && ttft < 1000) {
      conclusions.push('Token生成速度测试结果显示LLM API性能良好。');
    } else {
      conclusions.push('Token生成速度测试结果显示LLM API性能有待提升。');
    }
  }

  return conclusions.join(' ') || '测试已完成，请查看详细结果。';
}

/**
 * 格式化延迟时间
 * @param {number} ms - 毫秒数
 * @returns {string} 格式化后的字符串
 */
function formatLatency(ms) {
  if (ms < 1000) {
    return `${ms.toFixed(0)} ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)} s`;
  } else {
    return `${(ms / 60000).toFixed(2)} min`;
  }
}

export default {
  generateReport
};