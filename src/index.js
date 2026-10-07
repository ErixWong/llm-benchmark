#!/usr/bin/env node

/**
 * LLM API Benchmark Tool
 * LLM API Token生成速度测试工具
 */

import { program } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { runLlmBenchmarkTest } from './llm-benchmark.js';
import { generateReport } from './reporter.js';
import { countMessagesTokens } from './context-generator.js';
import { parseExtraBody, sanitizeExtraBody } from './extra-body.js';
import { selectSampleFiles } from './sample-select.js';
import { loadBank, selectBankItems, selectBankItemsByIds } from './bank.js';
import { buildMaterial, hashMaterialBank } from './cache-source.js';
import {
  buildProbeUnits,
  evaluateProbePreflight,
  makeRunSalt
} from './cache-probe.js';
import { buildRequestPlan, selectDocuments } from './cache-plan.js';

// 加载环境变量
dotenv.config();

// 提示词模板 - 用于大样本测试
const PROMPT_TEMPLATE = '请从下列样本中选取一个进行仿写扩写。\n\n';

// 简单默认提示词 - 用于非样本测试
// 默认样本文件匹配规则
const DEFAULT_SAMPLE_PATTERNS = [
  /-(8k|16k)/,  // 匹配 -8k 或 -16k
  /^(sample|novel|tech-news|conversation|code-samples|multimodal)-/  // 匹配特定前缀
];

/**
 * 检查文件名是否匹配样本规则
 * @param {string} filename - 文件名
 * @returns {boolean} 是否匹配
 */
function matchesSamplePattern(filename) {
  // 优先使用环境变量配置的规则
  if (process.env.SAMPLE_FILE_PATTERNS) {
    const patterns = process.env.SAMPLE_FILE_PATTERNS.split(',').map(p => new RegExp(p.trim()));
    return patterns.some(pattern => pattern.test(filename));
  }
  // 使用默认规则
  return DEFAULT_SAMPLE_PATTERNS.some(pattern => pattern.test(filename));
}

// 简单默认提示词 - 用于非样本测试
const SIMPLE_PROMPT = '请写一篇关于人工智能发展历程的文章，包括重要的里程碑事件和未来展望。';

program
  .name('llm-benchmark')
  .description('LLM API Token生成速度测试工具')
  .version('1.0.0');

/**
 * 安全解析整数，验证NaN
 * @param {string} value - 字符串值
 * @param {number} defaultValue - 默认值
 * @param {string} name - 参数名称(用于错误提示)
 * @returns {number} 解析后的整数
 */
function safeParseInt(value, defaultValue, name) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(chalk.yellow(`⚠️ 参数 ${name} 值 "${value}" 不是有效数字，使用默认值 ${defaultValue}`));
    return defaultValue;
  }
  return parsed;
}

/**
 * 递归扫描目录获取所有样本文件
 * @param {string} dir - 目录路径
 * @param {string} baseDir - 基准目录
 * @returns {Promise<string[]>} 样本文件列表
 */
async function scanSampleFiles(dir, baseDir = dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await scanSampleFiles(fullPath, baseDir);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.txt')) {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  
  return files.sort();
}

/**
 * 创建动态生成输入文本的函数
 * @param {number} sampleCount - 样本数量
 * @param {string[]} sampleFiles - 样本文件列表
 * @param {number} sampleSeed - 样本选择种子
 * The returned function takes a zero-based request index; estimates and warm-up use 0.
 * @returns {(requestIndex?: number) => Promise<string>} 输入文本生成函数
 */
function createInputGenerator(sampleCount, sampleFiles, sampleSeed, bankSelections = null) {
  return async (requestIndex = 0) => {
    if (bankSelections) {
      const item = bankSelections[requestIndex % bankSelections.length];
      return item.prompt;
    }
    if (sampleCount > 0 && sampleFiles.length > 0) {
      const selectedFiles = selectSampleFiles(sampleFiles, sampleCount, requestIndex, sampleSeed);
      
      const dataDir = path.join(process.cwd(), 'data');
      if (process.env.DEBUG) {
        console.log(chalk.gray(`请求 #${requestIndex + 1} 选中样本: ${selectedFiles.join(', ')}`));
      }
      const contents = await Promise.all(
        selectedFiles.map(f => fs.readFile(path.join(dataDir, f), 'utf-8'))
      );
      
      return PROMPT_TEMPLATE + contents.join('\n\n---\n\n');
    }
    return SIMPLE_PROMPT;
  };
}

// 默认测试命令 (token-speed 作为默认)
program
  .command('start', { isDefault: true })
  .description('运行Token生成速度测试 (默认命令)')
  .option('-c, --concurrency <number>', '并发数', process.env.DEFAULT_CONCURRENCY || '4')
  .option('-r, --rounds <number>', '采样轮数，总采样数 = 并发数 × 轮数', process.env.ROUNDS || '5')
  .option('-n, --sample-count <number>', '每次请求随机抽取的样本数量（0表示使用简单prompt）', process.env.SAMPLE_COUNT || '0')
  .option('-m, --max-output <number>', '最大输出Token数', process.env.MAX_OUTPUT_TOKENS || '30000')
  .option('--concurrency-mode <mode>', '并发模式: batch（批次）或 pipeline（流水线）', process.env.CONCURRENCY_MODE || 'pipeline')
  .option('-t, --timeout <seconds>', '请求超时时间(秒)', process.env.DEFAULT_TIMEOUT ? String(parseInt(process.env.DEFAULT_TIMEOUT) / 1000) : '90')
  .option('-u, --url <url>', 'API端点URL')
  .option('-k, --api-key <key>', 'API密钥')
  .option('--model <model>', '模型名称')
  .option('--system-prompt <prompt>', '系统提示词')
  .option('--extra-body <json>', '附加请求体参数（JSON字符串），例如 \'{"chat_template_kwargs":{"enable_thinking":false}}\'', process.env.EXTRA_BODY || '')
  .option('-o, --output <dir>', '输出目录', process.env.REPORT_OUTPUT_DIR || './results')
  .option('-q, --quiet', '静默模式，仅输出最终结果')
  .option('--sample-seed <number>', '确定性样本轮转种子', process.env.SAMPLE_SEED || '42')
  .option('--bank <name>', '使用 data/banks/<name>.json 题库', process.env.BANK || '')
  .option('--bank-items <ids>', '按逗号分隔的条目 ID 顺序循环选取（需同时指定 --bank）')
  .option('--cache-probe', '启用缓存命中探针', process.env.CACHE_PROBE === 'true')
  .option('--warmup-mode <mode>', '预热模式: auto | prefix | model | none', process.env.WARMUP_MODE || 'auto')
  .option('--prefix-tokens <number>', '每个单元素材的目标前缀Token数', process.env.PREFIX_TOKENS || '4096')
  .option('--cache-suffix <text>', '冷/热请求共用的追加后缀', '\n\n请用三点总结以上内容。')
  .option('--cache-seed <number>', '素材起点轮转种子', process.env.CACHE_SEED || '42')
  .option('--retry <number>', '最大重试次数；0 表示关闭重试', process.env.RETRY || '3')
  .option('--dry-run', '仅输出测试配置，不实际执行请求')
  .action(async (options) => {
    const url = options.url || process.env.API_BASE_URL;
    const apiKey = options.apiKey || process.env.API_KEY;
    const model = options.model || process.env.API_MODEL;
    const quiet = options.quiet || false;
    const dryRun = options.dryRun || false;
    
    // 必填参数检查
    if (!url) {
      console.error(chalk.red('❌ 错误: 请在 .env 文件中配置 API_BASE_URL 或使用 -u 参数'));
      process.exit(1);
    }
    if (!model) {
      console.error(chalk.red('❌ 错误: 请在 .env 文件中配置 API_MODEL 或使用 --model 参数'));
      process.exit(1);
    }
    
    if (!quiet) {
      console.log(chalk.blue('⚡ 开始Token生成速度测试...'));
    }
    
    const concurrency = safeParseInt(options.concurrency, 4, 'concurrency');
    const rounds = safeParseInt(options.rounds, 5, 'rounds');
    const sampleCount = safeParseInt(options.sampleCount, 0, 'sampleCount');
    const maxOutputTokens = safeParseInt(options.maxOutput, 30000, 'maxOutput');
    const timeout = safeParseInt(options.timeout, 90, 'timeout') * 1000;
    const concurrencyMode = options.concurrencyMode;
    const cacheProbeEnabled = options.cacheProbe || false;
    const sampleSeed = safeParseInt(options.sampleSeed, 42, 'sampleSeed');
    const warmupMode = options.warmupMode;
    const prefixTokens = safeParseInt(options.prefixTokens, 4096, 'prefixTokens');
    const cacheSeed = safeParseInt(options.cacheSeed, 42, 'cacheSeed');
    const retry = safeParseInt(options.retry, 3, 'retry');
    const unitCount = concurrency * rounds;
    const samples = cacheProbeEnabled ? 2 * unitCount : unitCount;
    const bankName = options.bank;
    const hasBankItems = options.bankItems !== undefined;

    if (bankName && sampleCount > 0) {
      console.error(chalk.red('❌ 错误: --bank 与 -n N（N > 0）素材来源互斥'));
      process.exit(1);
    }
    if (bankName && cacheProbeEnabled) {
      console.error(chalk.red('❌ 错误: 题库暂不支持缓存探针场景'));
      process.exit(1);
    }
    if (hasBankItems && !bankName) {
      console.error(chalk.red('❌ 错误: --bank-items 需要同时指定 --bank'));
      process.exit(1);
    }

    let bank = null;
    let explicitBankItems = null;
    if (bankName) {
      try {
        bank = await loadBank(process.cwd(), bankName);
      } catch (error) {
        console.error(chalk.red(`❌ ${error.message}`));
        process.exit(1);
      }
    }
    if (hasBankItems) {
      const ids = options.bankItems.split(',').map(id => id.trim());
      if (ids.some(id => id === '')) {
        console.error(chalk.red('❌ 错误: --bank-items 中的条目 ID 不能为空'));
        process.exit(1);
      }
      console.warn(chalk.yellow('⚠️ --bank-items 已指定，按给定 ID 顺序覆盖题库自动选择'));
      try {
        explicitBankItems = selectBankItemsByIds(bank, ids);
      } catch (error) {
        console.error(chalk.red(`❌ ${error.message}`));
        process.exit(1);
      }
    }

    if (!['auto', 'prefix', 'model', 'none'].includes(warmupMode)) {
      console.error(chalk.red(`❌ 错误: 无效的 --warmup-mode "${warmupMode}"，可选 auto、prefix、model、none`));
      process.exit(1);
    }
    if (!cacheProbeEnabled && warmupMode === 'prefix') {
      console.error(chalk.red('❌ 错误: warmup-mode prefix 需要启用 --cache-probe'));
      process.exit(1);
    }
    if (cacheProbeEnabled && warmupMode === 'none') {
      console.error(chalk.red('❌ 错误: 缓存探针必须预热前缀，请使用默认 prefix 或 model'));
      process.exit(1);
    }
    if (prefixTokens < 1) {
      console.error(chalk.red('❌ 错误: --prefix-tokens 必须大于 0'));
      process.exit(1);
    }
    if (retry < 0) {
      console.error(chalk.red('❌ 错误: --retry 必须大于或等于 0'));
      process.exit(1);
    }
    
    // 验证并发模式
    if (!['batch', 'pipeline'].includes(concurrencyMode)) {
      if (!quiet) {
        console.warn(chalk.yellow(`⚠️ 无效的并发模式 "${concurrencyMode}"，使用默认值 "pipeline"`));
      }
    }
    
    // 扫描样本文件
    let sampleFiles = [];
    if (sampleCount > 0 || cacheProbeEnabled) {
      try {
        const dataDir = path.join(process.cwd(), 'data');
        sampleFiles = await scanSampleFiles(dataDir);
        sampleFiles = sampleFiles.filter(f => matchesSamplePattern(path.basename(f)));
        
        if ((sampleCount > 0 || cacheProbeEnabled) && sampleFiles.length === 0) {
          console.error(chalk.red('❌ 没有找到样本文件'));
          process.exit(1);
        }
        
        // 按目录分类统计
        const categories = {};
        for (const f of sampleFiles) {
          const dir = path.dirname(f);
          const category = dir === '.' ? 'root' : dir.replace(/\\/g, '/');
          categories[category] = (categories[category] || 0) + 1;
        }
        
        if (!quiet) {
        console.log(chalk.gray(`📚 找到 ${sampleFiles.length} 个样本文件:`));
        for (const [cat, count] of Object.entries(categories)) {
          console.log(chalk.gray(`   ${cat}: ${count} 个`));
        }
      }
      } catch (error) {
        console.error(chalk.red(`❌ 无法读取样本目录: ${error.message}`));
        process.exit(1);
      }
    }
    
    // 获取报告标题
    const reportTitle = process.env.REPORT_TITLE || model;

    // 解析附加请求体参数
    let extraBody = null;
    if (options.extraBody) {
      try {
        const { body, dropped } = sanitizeExtraBody(parseExtraBody(options.extraBody));
        extraBody = body;
        if (dropped.length > 0) {
          console.warn(chalk.yellow(`⚠️ --extra-body 中的保留字段已忽略: ${dropped.join(', ')}`));
        }
      } catch (e) {
        console.error(chalk.red(`❌ 错误: --extra-body ${e.message}`));
        process.exit(1);
      }
    }
    
    // 创建输入生成器
    const sampleSelections = sampleCount > 0 && !cacheProbeEnabled
      ? Array.from(
        { length: samples },
        (_, requestIndex) => selectSampleFiles(sampleFiles, sampleCount, requestIndex, sampleSeed)
      )
      : [];
    const bankSelections = bank
      ? Array.from(
        { length: Math.max(samples, 1) },
        (_, requestIndex) => explicitBankItems
          ? explicitBankItems[requestIndex % explicitBankItems.length]
          : selectBankItems(bank, 1, requestIndex, sampleSeed)[0]
      )
      : null;
    const generateInputText = createInputGenerator(sampleCount, sampleFiles, sampleSeed, bankSelections);
    
    let units = null;
    let requestPlan = null;
    let runSalt = null;
    let probeSelfCheck = null;
    let cacheProbeOptions = null;
    if (cacheProbeEnabled) {
      try {
        const dataDir = path.join(process.cwd(), 'data');
        const fileContents = await Promise.all(
          sampleFiles.map(file => fs.readFile(path.join(dataDir, file), 'utf-8'))
        );
        const documentsByName = new Map(sampleFiles.map((name, index) => [
          name,
          { name, text: fileContents[index] }
        ]));
        const materials = [];
        for (let i = 0; i < unitCount; i++) {
          const documents = selectDocuments(sampleFiles, i, cacheSeed % sampleFiles.length)
            .map(name => documentsByName.get(name));
          const material = buildMaterial({ documents, targetTokens: prefixTokens });
          materials.push({
            id: documents[0].name,
            text: material.text,
            tokens: material.tokens
          });
        }
        const bankHash = hashMaterialBank(fileContents.map((text) => ({ text })));

        runSalt = makeRunSalt();
        units = buildProbeUnits({
          materials,
          suffix: options.cacheSuffix,
          runSalt
        });
        probeSelfCheck = evaluateProbePreflight(units);
        if (!probeSelfCheck.ok) {
          console.error(chalk.red('❌ 缓存探针前缀自检失败'));
          for (const error of probeSelfCheck.errors) {
            console.error(chalk.red(`  ${error}`));
          }
          process.exit(1);
        }

        requestPlan = buildRequestPlan(units);
        cacheProbeOptions = {
          units,
          suffix: options.cacheSuffix,
          warmupMode: warmupMode === 'auto' ? 'prefix' : warmupMode,
          order: 'cold-warm',
          runSalt,
          bank: { name: 'chunked-samples', hash: bankHash },
          prefixValidation: probeSelfCheck
        };
      } catch (error) {
        console.error(chalk.red(`❌ 无法构造缓存探针素材: ${error.message}`));
        process.exit(1);
      }
    }

    // 预估 token 数
    const sampleInput = cacheProbeEnabled
      ? requestPlan[0]?.text || ''
      : await generateInputText(0);
    const estimatedTokens = countMessagesTokens([{ role: 'user', content: sampleInput }]);
    
    if (!quiet) {
      console.log(chalk.gray(`模型: ${model}`));
      console.log('测试参数:');
      console.log(`  并发数: ${concurrency}`);
      console.log(`  采样轮数: ${rounds}`);
      if (cacheProbeEnabled) {
        console.log(`  缓存探针单元数: ${unitCount} (${concurrency} × ${rounds})`);
        console.log(`  计时请求数: ${samples} (每单元 cold + warm)`);
      } else {
        console.log(`  总采样数: ${samples} (${concurrency} × ${rounds})`);
      }
      if (cacheProbeEnabled) {
        console.log(`  探针素材文件数: ${sampleFiles.length}（按 cache-seed 确定性轮转）`);
        if (sampleCount > 0) {
          console.log(`  -n ${sampleCount} 已触发样本扫描；探针素材按完整匹配文件集构造`);
        }
      } else if (sampleCount > 0) {
        console.log(`  每次确定性选取: ${sampleCount} 个样本`);
        console.log(`  样本 seed: ${sampleSeed}`);
        console.log(`  匹配样本文件 (${sampleFiles.length}): ${sampleFiles.join(', ')}`);
        for (const [requestIndex, selectedFiles] of sampleSelections.entries()) {
          console.log(`  请求 #${requestIndex + 1} 素材: ${selectedFiles.join(', ')}`);
        }
      } else if (bank) {
        const tierCounts = {};
        for (const item of bank.items) {
          const tier = typeof item.tags.outputTier === 'string' && item.tags.outputTier.trim()
            ? item.tags.outputTier
            : '__default__';
          tierCounts[tier] = (tierCounts[tier] || 0) + 1;
        }
        console.log(`  题库名称/版本: ${bank.name} / ${bank.version}`);
        console.log(`  题库 hash: ${bank.hash}`);
        console.log(`  题库条目数: ${bank.items.length}`);
        console.log(`  题库分层计数: ${Object.entries(tierCounts).map(([tier, count]) => `${tier}=${count}`).join(', ')}`);
        if (explicitBankItems) {
          console.log(`  定点条目 ID（循环）: ${explicitBankItems.map(item => item.id).join(', ')}`);
        }
        for (const [requestIndex, item] of bankSelections.slice(0, samples).entries()) {
          console.log(`  请求 #${requestIndex + 1} 素材: ${item.id}`);
        }
      } else {
        console.log(`  使用默认简单Prompt`);
      }
      console.log(`  预估输入Token数: ${estimatedTokens}`);
      console.log(`  最大输出Token数: ${maxOutputTokens}`);
      console.log(`  请求超时: ${timeout / 1000}s`);
      console.log(`  并发模式: ${concurrencyMode === 'pipeline' ? '流水线' : '批次'}`);
      if (extraBody) {
        console.log(`  附加请求体: ${JSON.stringify(extraBody)}`);
      }
      console.log(`  API URL: ${url}`);
      console.log('');
    }

    if (cacheProbeEnabled) {
      console.log(chalk.cyan('缓存探针配置:'));
      console.log(`  单元数: ${unitCount}`);
      console.log(`  目标前缀Token数: ${prefixTokens}`);
      for (const unit of units) {
        console.log(`  单元 ${unit.unitIndex + 1} [${unit.itemId}]: 实际前缀Token数 ${unit.prefixTokens}`);
      }
      console.log(`  runSalt: ${runSalt}`);
      console.log(`  warmupMode: ${cacheProbeOptions.warmupMode}`);
      const suffixPreview = options.cacheSuffix.length > 80
        ? `${options.cacheSuffix.slice(0, 80)}...`
        : options.cacheSuffix;
      console.log(`  后缀预览: ${JSON.stringify(suffixPreview)}`);
      console.log(`  请求顺序: ${cacheProbeOptions.order}`);
      console.log(`  前缀自检: 唯一性通过；热前缀匹配 ${probeSelfCheck.verified}/${probeSelfCheck.total} 通过`);
      console.log('');
    }
    
    // Dry-run 模式：仅输出配置
    if (dryRun) {
      console.log(chalk.yellow('🔍 Dry-run 模式：仅输出配置，不执行请求'));
      console.log(chalk.green('✅ 配置验证通过'));
      process.exit(0);
    }
    
    try {
      const results = await runLlmBenchmarkTest({
        url,
        apiKey,
        model,
        inputTokens: estimatedTokens,
        maxOutputTokens,
        samples,
        concurrency,
        concurrencyMode,
        sampleCount,
        sampleSeed,
        sampleFiles,
        sampleSelections: sampleSelections.map((files, requestIndex) => ({ requestIndex, files })),
        ...(bank ? {
          bank: {
            name: bank.name,
            version: bank.version,
            hash: bank.hash,
            itemCount: bank.items.length
          },
          bankItemIds: bankSelections.map(item => item.id)
        } : {}),
        generateInputText,
        timeout,
        extraBody,
        quiet,
        warmupMode: cacheProbeEnabled ? cacheProbeOptions.warmupMode : warmupMode,
        retry,
        ...(cacheProbeEnabled ? {
          requestPlan,
          cacheProbe: cacheProbeOptions,
          cacheSeed,
          prefixTokens,
          runSalt
        } : {})
      });
      
      // 检查测试是否成功
      if (!results.success) {
        console.error(chalk.red('❌ 测试失败:'), results.error || '所有请求均失败');
        process.exit(1);
      }
      
      // 为每份报告创建单独的目录
      const now = new Date();
      const pad = (n) => n.toString().padStart(2, '0');
      const localTimestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const reportDir = `${options.output}/report-${localTimestamp}`;
      
      // 添加报告标题到结果中
      results.reportTitle = reportTitle;
      
      await generateReport({ tokenSpeed: results }, reportDir);
      if (!quiet) {
        console.log(chalk.green('✅ 测试完成!'));
      }
    } catch (error) {
      console.error(chalk.red('❌ 测试失败:'), error.message);
      process.exit(1);
    }
  });

program.parse();