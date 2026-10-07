# LLM API Benchmark

针对 OpenAI Chat Completions 兼容端点的命令行压测工具：测量 token 生成速度、首 token 延迟、
吞吐与成功率，产出 JSON / Markdown / HTML 报告。指标口径与 NVIDIA AIPerf、`vllm bench serve`、
Artificial Analysis 对齐，对推理模型（reasoning / thinking）有一等支持。

Node.js >= 18，ESM，无构建步骤。指标定义与结果判读见 [`docs/metrics.md`](docs/metrics.md)。

## 快速开始

```bash
npm install
cp .env.example .env                 # 至少填 API_BASE_URL / API_KEY / API_MODEL
node src/index.js --dry-run          # 只校验配置，不发请求
node src/index.js -c 1 -r 1 -n 0 -m 512
```

不用 `.env` 也可以全部走命令行：

```bash
node src/index.js -u https://api.example.com/v1 -k sk-xxx --model gpt-4o-mini \
  -c 1 -r 3 -n 0 -m 512
```

## 命令行参数

只有默认子命令 `start`（可省略）。

| 选项 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `-u, --url <url>` | `API_BASE_URL` | **必填** | API 端点，支持自动补全路径 |
| `-k, --api-key <key>` | `API_KEY` | 无 | 提供时发送 `Authorization: Bearer <key>` |
| `--model <model>` | `API_MODEL` | **必填** | 模型名 |
| `-c, --concurrency <n>` | `DEFAULT_CONCURRENCY` | `4` | 并发数 |
| `-r, --rounds <n>` | `ROUNDS` | `5` | 采样轮数，**总请求数 = 并发 × 轮数** |
| `-n, --sample-count <n>` | `SAMPLE_COUNT` | `0` | 每次请求确定性轮转选取的样本数，`0` = 内置简单 prompt |
| `--sample-seed <n>` | `SAMPLE_SEED` | `42` | `-n > 0` 时决定样本轮转起点；相同素材集、种子和请求序号会选中相同文件 |
| `--bank <name>` | `BANK` | 无 | 使用 `data/banks/<name>.json` 题库替代默认 prompt |
| `--bank-items <ids>` | — | 无 | 逗号分隔的条目 ID，按给定顺序循环选取以复现结果；需同时指定 `--bank` |
| `-m, --max-output <n>` | `MAX_OUTPUT_TOKENS` | `30000` | `max_tokens` |
| `--concurrency-mode <mode>` | `CONCURRENCY_MODE` | `pipeline` | `pipeline`（完成一个补一个）/ `batch`（整批等） |
| `-t, --timeout <sec>` | `DEFAULT_TIMEOUT`（毫秒） | `90` | 单次请求超时 |
| `--system-prompt <prompt>` | — | 无 | 自定义 system prompt |
| `--extra-body <json>` | `EXTRA_BODY` | 空 | 透传服务端特有参数，见下文 |
| `--cache-probe` | `CACHE_PROBE` | `false` | 启用冷/热缓存探针；每个单元先预热前缀，再发 cold/warm 请求 |
| `--warmup-mode <mode>` | `WARMUP_MODE` | `auto` | `auto`（探针时等同 `prefix`）/ `prefix` / `model` / `none`（仅非探针） |
| `--prefix-tokens <number>` | `PREFIX_TOKENS` | `4096` | 每个缓存探针单元的目标前缀 token 数 |
| `--cache-suffix <text>` | — | 固定总结提示 | 冷/热请求共用的追加后缀 |
| `--cache-seed <number>` | `CACHE_SEED` | `42` | 确定性轮转探针素材的起点 |
| `--retry <number>` | `RETRY` | `3` | 最大重试次数；`0` 关闭重试 |
| `-o, --output <dir>` | `REPORT_OUTPUT_DIR` | `./results` | 报告输出目录 |
| `-q, --quiet` | — | `false` | 只输出最终摘要 |
| `--dry-run` | — | — | 只打印并校验配置，不发请求 |

表中的默认值是**未配置 `.env` 时**的代码回退值。

其他行为：

- **URL 自动补全**：`https://x/v1` → `https://x/v1/chat/completions`；`https://x` → `https://x/v1/chat/completions`；已含完整路径则原样使用
- **重试**：最多 3 次，指数退避 1s → 2s → 4s；仅针对 `408/429/500/502/503/504` 与连接类错误；`429` 尊重 `Retry-After`
- **预热**：正式计时前发 1 次预热请求，不计入任何指标；预热收到 4xx/5xx 会直接终止
- **缓存探针**：每个探针单元先串行预热一个固定前缀，再以不同 nonce 成对发送 cold/warm；`--warmup-mode model` 会先用唯一 nonce 预热模型/JIT，再串行预热待测前缀；探针不允许 `none`（非探针下 `none` 表示不预热）
- **Token 计数**：默认携带 `stream_options.include_usage` 以获取服务端精确计数；端点不支持时按报错提示关闭（见 `docs/metrics.md`）

## 环境变量

| 变量 | 用途 |
|------|------|
| `API_BASE_URL` / `API_KEY` / `API_MODEL` | 端点、密钥、模型 |
| `USER_AGENT` | 请求 UA，默认 `llm-benchmark/1.0.0` |
| `DEFAULT_CONCURRENCY` / `ROUNDS` / `MAX_OUTPUT_TOKENS` | 并发 / 轮数 / `max_tokens` |
| `CONCURRENCY_MODE` | `pipeline` \| `batch` |
| `DEFAULT_TIMEOUT` | 请求超时，**单位毫秒** |
| `SAMPLE_COUNT` / `SAMPLE_SEED` / `SAMPLE_FILE_PATTERNS` | 样本数量 / 确定性轮转种子（也用于题库）/ 自定义样本文件名正则（逗号分隔，覆盖默认规则） |
| `BANK` | 题库名称，对应 `data/banks/<name>.json` |
| `CACHE_PROBE` / `WARMUP_MODE` | 是否启用缓存探针 / 预热方式 |
| `PREFIX_TOKENS` / `CACHE_SEED` / `RETRY` | 缓存前缀目标长度 / 素材起点 / 最大重试次数 |
| `EXTRA_BODY` | 透传请求体参数（JSON 字符串） |
| `REPORT_OUTPUT_DIR` / `REPORT_TITLE` | 输出目录 / 报告标题（默认取模型名） |
| `REPORT_INCLUDE_TEXT` | `true` 时把模型输出全文写入 JSON 报告，默认不写 |
| `DEBUG` | 置任意值时打印流式解析错误 |

## 指标一览

| 字段 | 一句话 |
|------|--------|
| `ttft` | 到**首个生成 token**的时延（推理模型的 reasoning 就是第一个 token） |
| `ttfo` | 到首个**可见答案 token**的时延 |
| `tps` | 单请求解码速度（不含 TTFT） |
| `throughputTps` | 系统级吞吐：总输出 token ÷ 墙钟时间 |
| `decodeThroughputTps` | 总输出 token ÷ 解码窗口并集时长，重叠窗口只计一次 |
| `effectiveDecodeConcurrency` | 实际解码时长总和 ÷ 墙钟时间，表示有效解码并发度 |
| `cache` | 仅在 `--cache-probe` 时出现：冷/热 TTFT、逐单元配对差值、服务端上报的缓存 token 命中率与判定 |
| `diagnostics` | **始终存在**：截断请求数与疑似响应级缓存请求数（诊断线索，非缓存命中证明） |

### 指标口径

缓存 verdict 以成对的 `warm_i - cold_i` TTFT 差值判定，`ttftDeltaMs`（冷热组中位数之差）
与 `ttftRatio` 仅作参考；原因码见 [`docs/metrics.md`](docs/metrics.md#缓存命中)。

**定义依据、口径版本（`metricsVersion`）、token 计数来源、并发饱和怎么判读** ——
全部在 [`docs/metrics.md`](docs/metrics.md)。

> ⚠️ `ttft` 口径已于 2026-10 变更，与旧报告不可直接对比，详见 `CHANGELOG.md`。

**本工具不做**：按持续时间 / rampUp 加压、RPS 与 P50/P90/P99 分位数、ITL（token 间延迟）、
服务端资源指标（GPU / 显存 / 排队深度）。原因与替代工具见
[`docs/metrics.md`](docs/metrics.md) 的「范围边界」一节。

## `--extra-body`

透传 OpenAI 标准字段之外的服务端特有参数：

```bash
# 关闭 GLM / Qwen 思考模式
node src/index.js --extra-body '{"chat_template_kwargs":{"enable_thinking":false}}'

# 组合多个参数
node src/index.js --extra-body '{"top_p":0.9,"chat_template_kwargs":{"thinking":{"type":"disabled"}}}'
```

`model`、`messages`、`max_tokens`、`stream` 由压测工具自己控制，写在这里会被**忽略并告警**
（覆盖 `stream:false` 会让流式解析拿不到数据，整轮指标作废）。

## 报告产物

每次运行输出到 `<输出目录>/report-<时间戳>/`：

| 文件 | 内容 |
|------|------|
| `benchmark-<时间戳>.json` | `metricsVersion` + `config` / `metrics` / `errors` / `raw`（每请求明细）/ `failed` |
| `benchmark-<时间戳>.md` | Markdown 摘要 |
| `benchmark-<时间戳>.html` | TPS / TTFT 分布图与请求甘特图 |

模型输出全文默认不写入报告；需要时设 `REPORT_INCLUDE_TEXT=true`。

## 常用配方

| 目的 | 命令 |
|------|------|
| 连通性检查 | `--dry-run` |
| 单流基线 | `-c 1 -r 3 -n 0 -m 512` |
| 并发扫描 | `for c in 1 4 8 16; do node src/index.js -c $c -r 2 -n 0 -m 512 -o results/sweep/c$c; done` |
| 最差批次表现 | `--concurrency-mode batch` |
| 大上下文输入 | `-n 2 --sample-seed 42`（每次按请求序号确定性轮转拼 2 个样本） |
| 冷/热缓存对比 | `node src/index.js --cache-probe --warmup-mode prefix -c 1 -r 3 --prefix-tokens 4096` |
| 模型预热后的缓存对比 | `node src/index.js --cache-probe --warmup-mode model -c 1 -r 3`（先预热模型/JIT，再串行 priming 待测前缀） |
| 干净测量、不重试 | `node src/index.js --cache-probe --retry 0 -c 1 -r 3` |

> 固定输入反复压同一服务端会命中前缀缓存导致吞吐虚高；需要干净数据时换输入或清服务端缓存。

## 大上下文样本

`-n > 0` 时递归扫描 `data/` 下的 `.txt`，按文件名匹配：含 `-8k` / `-16k`，
或以 `sample-` / `novel-` / `tech-news-` / `conversation-` / `code-samples-` / `multimodal-` 开头。
可用 `SAMPLE_FILE_PATTERNS` 覆盖规则；`-n 0` 时使用内置 prompt，不读文件。

仓库自带 22 个样本（`data/samples/{code,dialogue,literature,mixed,news,tech}/`），
实测单个 **4.7k ～ 15.3k token**（中位约 7.5k）——文件名里的 `8k` 是标称值。

## 素材来源与场景正交

素材来源有三种，按场景选择：

- `chunked-samples`：`--cache-probe` 使用的切块素材，只用于缓存探针；题库暂不支持缓存探针场景。
- `--bank <name>`：从 `data/banks/<name>.json` 读取列表型题库，每个计时请求使用一个条目的 `prompt`；
  `-n N`（N > 0）与题库互斥。题库条目的 `expected` 仅保存预期输出 token 数和文本，**绝不拼入 prompt**。
- `-n N`：从 `data/` 下的文本文件组装大上下文；`-n 0` 且未指定题库时使用内置简单 prompt。

题库按 `tags.outputTier` 分层（缺失时归入 `__default__`）。每层根据 `--sample-seed` 做确定性洗牌，
随后各层轮流取条目；整库选完后从头开始。相同题库、seed 和请求序号选取相同条目，层内条目使用次数保持均匀。
`--bank-items id1,id2` 会告警并覆盖自动轮转，按给定 ID 顺序循环分配；可用它定点复现某些条目。

```bash
node src/index.js --bank poems -c 1 -r 3 -n 0
node src/index.js --bank poems --bank-items wujue-jingyesi,wujue-chunxiao -c 1 -r 3 -n 0
```

## 常见问题

| 现象 | 处理 |
|------|------|
| `TPS = 0` / `TTFT = N/A` | 确认端点正常流式返回；推理模型见下一条 |
| `ttfo` 为空、答案为空 | `-m` 太小，输出全被思考占满：加大 `-m` 或关闭思考模式 |
| token 数看着不对 | 看摘要「Token来源」：`客户端估算` 表示端点没回 usage，绝对值是近似值 |
| 我开了 prefix caching 但命中率是 0 | 用服务端 `/metrics`（如 `vllm:prefix_cache_hits_total`、`vllm:prompt_tokens_cached_total`）核对；本工具只能如实报告它观测到的服务端 usage 和冷/热行为，无法从客户端推断服务端命中 |
| 请求 400 | 端点不接受 `stream_options`，用 `--extra-body '{"stream_options":{"include_usage":false}}'` |
| `没有找到样本文件` | `-n > 0` 但 `data/` 下无匹配 `.txt`：检查文件名规则或改 `-n 0` |
| 超时 | 长输出增大 `-t`；`.env` 里 `DEFAULT_TIMEOUT` 单位是毫秒 |
| 想看流解析细节 | `DEBUG=1 node src/index.js ...` |

## 开发与测试

```bash
npx vitest run          # 全部测试
npx vitest              # watch 模式
```

工程约定（目录边界、指标口径变更流程、提交规范、审查清单）见 [`AGENTS.md`](AGENTS.md)。

```
├── src/          源码（index / llm-benchmark / token-stats / extra-body / http-client / reporter / context-generator）
├── tests/        vitest 用例
├── docs/         设计与用法文档
├── data/samples/ 大上下文样本
└── results/      报告输出（gitignored）
```

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/metrics.md`](docs/metrics.md) | 指标权威定义、口径版本、token 计数来源、并发结果判读、测量陷阱与范围边界 |
| [`AGENTS.md`](AGENTS.md) | 工程约定与审查清单 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更历史（含指标口径的 BREAKING 记录） |

## License

MIT
