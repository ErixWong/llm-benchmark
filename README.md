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
| `-n, --sample-count <n>` | `SAMPLE_COUNT` | `0` | 每次请求抽取的样本数，`0` = 内置简单 prompt |
| `-m, --max-output <n>` | `MAX_OUTPUT_TOKENS` | `30000` | `max_tokens` |
| `--concurrency-mode <mode>` | `CONCURRENCY_MODE` | `pipeline` | `pipeline`（完成一个补一个）/ `batch`（整批等） |
| `-t, --timeout <sec>` | `DEFAULT_TIMEOUT`（毫秒） | `90` | 单次请求超时 |
| `--system-prompt <prompt>` | — | 无 | 自定义 system prompt |
| `--extra-body <json>` | `EXTRA_BODY` | 空 | 透传服务端特有参数，见下文 |
| `-o, --output <dir>` | `REPORT_OUTPUT_DIR` | `./results` | 报告输出目录 |
| `-q, --quiet` | — | `false` | 只输出最终摘要 |
| `--dry-run` | — | — | 只打印并校验配置，不发请求 |

表中的默认值是**未配置 `.env` 时**的代码回退值。

其他行为：

- **URL 自动补全**：`https://x/v1` → `https://x/v1/chat/completions`；`https://x` → `https://x/v1/chat/completions`；已含完整路径则原样使用
- **重试**：最多 3 次，指数退避 1s → 2s → 4s；仅针对 `408/429/500/502/503/504` 与连接类错误；`429` 尊重 `Retry-After`
- **预热**：正式计时前发 1 次预热请求，不计入任何指标；预热收到 4xx/5xx 会直接终止
- **Token 计数**：默认携带 `stream_options.include_usage` 以获取服务端精确计数；端点不支持时按报错提示关闭（见 `docs/metrics.md`）

## 环境变量

| 变量 | 用途 |
|------|------|
| `API_BASE_URL` / `API_KEY` / `API_MODEL` | 端点、密钥、模型 |
| `USER_AGENT` | 请求 UA，默认 `llm-benchmark/1.0.0` |
| `DEFAULT_CONCURRENCY` / `ROUNDS` / `MAX_OUTPUT_TOKENS` | 并发 / 轮数 / `max_tokens` |
| `CONCURRENCY_MODE` | `pipeline` \| `batch` |
| `DEFAULT_TIMEOUT` | 请求超时，**单位毫秒** |
| `SAMPLE_COUNT` / `SAMPLE_FILE_PATTERNS` | 样本数量 / 自定义样本文件名正则（逗号分隔，覆盖默认规则） |
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

**定义依据、口径版本（`metricsVersion`）、token 计数来源、并发饱和怎么判读** ——
全部在 [`docs/metrics.md`](docs/metrics.md)。

> ⚠️ `ttft` 口径已于 2026-10 变更，与旧报告不可直接对比，详见 `CHANGELOG.md`。

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
| 大上下文输入 | `-n 2`（每次随机拼 2 个样本） |

> 固定输入反复压同一服务端会命中前缀缓存导致吞吐虚高；需要干净数据时换输入或清服务端缓存。

## 大上下文样本

`-n > 0` 时递归扫描 `data/` 下的 `.txt`，按文件名匹配：含 `-8k` / `-16k`，
或以 `sample-` / `novel-` / `tech-news-` / `conversation-` / `code-samples-` / `multimodal-` 开头。
可用 `SAMPLE_FILE_PATTERNS` 覆盖规则；`-n 0` 时使用内置 prompt，不读文件。

仓库自带 22 个样本（`data/samples/{code,dialogue,literature,mixed,news,tech}/`），
实测单个 **4.7k ～ 15.3k token**（中位约 7.5k）——文件名里的 `8k` 是标称值。

## 常见问题

| 现象 | 处理 |
|------|------|
| `TPS = 0` / `TTFT = N/A` | 确认端点正常流式返回；推理模型见下一条 |
| `ttfo` 为空、答案为空 | `-m` 太小，输出全被思考占满：加大 `-m` 或关闭思考模式 |
| token 数看着不对 | 看摘要「Token来源」：`客户端估算` 表示端点没回 usage，绝对值是近似值 |
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
| [`docs/metrics.md`](docs/metrics.md) | 指标权威定义、口径版本、token 计数来源、并发结果判读 |
| [`AGENTS.md`](AGENTS.md) | 工程约定与审查清单 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更历史（含指标口径的 BREAKING 记录） |
| [`docs/README.md`](docs/README.md) | 通用压测方法论参考。**含本项目未实现的负载/压力/浸泡/峰值测试类型**，不作为本工具的行为说明 |

## License

MIT
