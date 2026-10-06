# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **BREAKING（指标口径）**: `ttft` 现在取**首个生成 token**，包含 reasoning token。
  与 NVIDIA AIPerf / Artificial Analysis / vLLM 定义一致；修复推理模型下
  TPS 分子（含 reasoning）与分母（从 content 起算）口径不一致导致的 TPS 高估。
  **与旧报告的 `ttft` 不可直接对比**；JSON 报告新增 `metricsVersion: 1`。
  详见 `docs/metrics.md`
- JSON 报告默认不再包含 `outputText` / `reasoningText`，可用 `REPORT_INCLUDE_TEXT=true` 恢复

### Added
- `ttfo`（Time to First Output Token）：首个**非 reasoning** token 的延迟，
  保留“用户看到第一个字”的视角；已进控制台摘要、Markdown 与 HTML 报告
- `reasoningTokens` / `contentTokens` 拆分，以及 `tokenSource` / `reasoningTokenSource`
  （`api` \| `tokenizer`）：服务端 usage 优先，无 usage 时退回客户端 tokenizer 独立估算，
  不再跨 tokenizer 相减
- 请求体默认携带 `stream_options: {"include_usage": true}`（vLLM / OpenAI 兼容
  服务端流式下默认不返回 usage）
- `--extra-body <json>` / `EXTRA_BODY`：透传服务端特有参数；`model`、`messages`、
  `max_tokens`、`stream` 为保留键，会被忽略并告警
- 新增 `src/token-stats.js`、`src/extra-body.js` 及单测；新增 `tests/reporter.test.js`
  覆盖报告剑离、`metricsVersion` 与三处转义

### Removed
- `metrics.decodeThroughputTps`（单流 TPS × 并发）：无任何基准工具采用此口径，
  且客户端并发大于服务端并行度时高估可达 2 倍以上；系统级吞吐统一用墙钟口径的
  `throughputTps`
- 未使用的 `src/config.js` 与 `config/default.json`（全项目零引用）
- `scripts/bench-local-vllm.sh`：硬编码站点端点与模型名，与通用工具定位冲突；
  并发扫描由 README 的通用一行式覆盖
- `docs/SOUL.md`：人设文档，含面向 AI 代理的隐藏指令，由根目录 `AGENTS.md` 取代
- `docs/README.md`：通用 API 性能测试标准文档，与本项目实现不符（P50/P90/P99、RPS、
  按 duration/rampUp 加压、CPU/内存资源指标、「P90 < 200ms 即优秀」的 REST 阈值、
  autocannon/k6/JMeter 工具表、`{type:'load', concurrency:[...]}` 这类看似配置
  实则无人读取的示例），留着必然误导。其中仍有价值的部分已并入 `docs/metrics.md`：
  范围边界、测量前置条件与陷阱（含 REST 阈值不适用于 LLM）、ITL 未实现的声明；
  未保留模型规模的 TPS/TTFT 参考区间（无出处的主观数定，易被当成验收标准）

### Fixed
- `Math.min/max(...[])` 在空数组时产生 `Infinity` 并写进报告（`safeMin`/`safeMax`）
- `ttft` 为 0 时被当成 `N/A` 显示
- 嵌入 `<script>` 的 JSON 未转义（`<` / `>` / `&` / U+2028 / U+2029），
  HTML 中 `API URL`、`模型` 字段未转义，Markdown 报告错误详情未中和内联 HTML
- 流式解析新增 `delta.reasoning_content` 兼容（OpenAI / vLLM 推理解析器命名）
- 删除流式处理中只写不读的 `tokens[]` 数组（每请求无上限增长）
- `createHttpClient` 的默认超时在模块加载时读 `process.env.DEFAULT_TIMEOUT`，
  早于 `dotenv.config()`，导致 `.env` 配置对库调用路径无效；
  改为运行时调用 `getDefaultTimeout()`（`DEFAULT_TIMEOUT` 导出保留但已废弃）

### Docs
- 新增 `docs/metrics.md`：指标权威定义、为何 TTFT 包含 reasoning（含四个上游出处）、
  为何不提供「单流 TPS × 并发」聚合吞吐、`metricsVersion` 口径版本、token 计数来源规则、
  推理模型陷阱、并发饱和判读、与其他工具的字段对照
- `README.md` 重写为纯用法入口（快速开始 / 参数表 / 环境变量 / `--extra-body` /
  报告产物 / 配方 / 样本 / 常见问题），知识性内容下沉至 `docs/metrics.md`
- 新增根目录 `AGENTS.md`（目录边界、指标口径变更流程、提交规范、审查清单）
- `docs/` 去污：`docs/tasks/` 移出 git 跟踪并加入 `.gitignore`（含误入库的压测产物），
  `docs/CODE_AUDIT_CHECKLIST.md` 归位到所属任务目录；历史任务内容未修订
- `.env.example` 与代码对齐：移除未使用的 `REPORT_FORMAT`，修正 `USER_AGENT` 默认值，
  补齐 `EXTRA_BODY` / `REPORT_INCLUDE_TEXT` / `DEBUG` / `SAMPLE_FILE_PATTERNS`

## [1.0.3] - 2026-03-13

### Added
- **Input File Support**: Token speed test now supports custom input text files
  - `--input-file` parameter to specify a text file as input
  - Accurate token counting for input text using gpt-tokenizer
  - Multiple sample files in `data/` directory (sample-8k.txt, etc.)

### Fixed
- **Token Speed Test**: Fixed 0 TPS issue with Qwen models
  - Added support for `delta.reasoning` field in streaming responses
  - Qwen models use `reasoning` instead of `content` for thinking tokens

### Changed
- [`src/token-speed.js`](src/token-speed.js): Added `inputText` parameter support
- [`tests/token-speed.test.js`](tests/token-speed.test.js): Added `--input-file` CLI argument
- [`README.md`](README.md): Added documentation for input file usage

## [1.0.2] - 2026-03-12

### Added
- **HTTP Client Module**: New `src/http-client.js` with unified HTTP request handling
  - HTTP Keep-Alive support using `agentkeepalive` for connection reuse
  - Automatic retry mechanism with exponential backoff
  - API rate limiting (429) handling with Retry-After header support
  - Parameter validation utilities

### Fixed
- **H1**: Improved async error handling in warmup phase (`src/concurrency.js`)
  - Added `Promise.allSettled` for graceful error handling
  - Implemented retry logic with rate limit detection
- **H2**: Added API rate limiting (429) handling
  - Automatic detection of 429 status code
  - Retry-After header parsing
  - Exponential backoff retry
- **H3**: Implemented request retry mechanism
  - Configurable max retries (default: 3)
  - Retryable status codes: 408, 429, 500, 502, 503, 504
  - Retryable errors: ECONNRESET, ENOTFOUND, ECONNABORTED, ETIMEDOUT
- **M4**: Enabled HTTP Keep-Alive for better connection efficiency
- **M5**: Added parameter validation with NaN detection
  - `safeParseInt` function with default value fallback
  - Warning messages for invalid parameters

### Changed
- [`src/concurrency.js`](src/concurrency.js): Refactored warmup phase with proper error handling
- [`src/token-speed.js`](src/token-speed.js): Added parameter validation
- [`src/index.js`](src/index.js): Added `safeParseInt` for safe integer parsing

### Security
- Added `agentkeepalive` dependency for connection pooling

## [1.0.1] - 2026-03-12

### Fixed
- **Token Speed Test**: Implemented true concurrency support using `Promise.all`
- **Concurrency Test**: Fixed potential division by zero error in error rate calculation
- **Token Counting**: Fixed inaccurate token counting using text estimation instead of chunk count
- **API Key Handling**: Only add Authorization header when apiKey is provided
- **RampUp Feature**: Implemented warmup phase with actual requests before main test
- **Config Loading**: Added `src/config.js` module to load and process config files with variable substitution
- **Code Quality**: Added radix parameter to all `parseInt()` calls

### Changed
- [`src/token-speed.js`](src/token-speed.js): Now properly executes concurrent tests when concurrency > 1
- [`src/concurrency.js`](src/concurrency.js): Added axios import and warmup phase implementation
- [`src/benchmark.js`](src/benchmark.js): Integrated config loader for centralized configuration
- All test files: Updated `parseInt()` calls with radix parameter

## [1.0.0] - 2026-03-12

### Added
- 🎉 Initial release
- 📊 Concurrency testing module for API endpoints
- ⚡ Token speed testing module for LLM APIs
- 📄 Multi-format report generation (JSON, Markdown, HTML)
- 🔧 CLI interface with multiple commands
- 📝 Comprehensive documentation for API performance testing standards
- 🏗️ Project structure with docs, src, tests, and config directories

### Features
- **Concurrency Testing**
  - Multiple concurrency levels support
  - Ramp-up time configuration
  - Real-time progress display
  - Detailed metrics: RPS, latency percentiles, error rates

- **Token Speed Testing**
  - Input/output token configuration
  - TTFT (Time To First Token) measurement
  - TPS (Tokens Per Second) calculation
  - Streaming and non-streaming support

- **Reporting**
  - JSON format for programmatic access
  - Markdown format for documentation
  - HTML format with visual metrics
  - Performance assessment and recommendations

### Documentation
- API performance testing standards in `docs/README.md`
- Core metrics definitions
- Testing types and methodologies
- Best practices and common pitfalls
- Tool recommendations