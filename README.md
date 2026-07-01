# LLM API Benchmark

用于压测 LLM API 输出速度的命令行工具，当前项目实际提供的是默认 `start` 命令，用来执行 Token 生成速度测试。

## 功能特性

- Token 生成速度测试：统计 TPS、TTFT、成功率等核心指标
- 并发模式支持：支持 `batch` 和 `pipeline` 两种请求调度方式
- 大上下文样本测试：可从 `data/samples/` 随机抽取多个文本样本拼接输入
- 报告输出：测试完成后自动在 `results/` 生成 HTML、JSON、Markdown 报告
- Dry-run 校验：可先验证配置和参数，不真正发请求

## 运行前提

- Node.js `>= 18`
- 可访问的兼容 OpenAI Chat Completions 的 API 地址
- 可用模型名，例如 `gpt-4o-mini`、`glm-4.5-air` 等

## 5 分钟上手

### 1. 安装依赖

```bash
npm install
```

### 2. 复制环境变量模板

macOS / Linux:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

### 3. 填写最小必需配置

至少需要配置下面 3 项：

```env
API_BASE_URL=https://api.example.com/v1/chat/completions
API_KEY=your-api-key-here
API_MODEL=gpt-4o-mini
```

其他参数可以先保持 `.env.example` 默认值。

### 4. 先做一次配置检查

```bash
node src/index.js --dry-run
```

看到 `配置验证通过` 就说明当前参数可用于正式测试。

### 5. 运行一次最小测试

```bash
node src/index.js -c 1 -r 1 -n 0
```

这条命令会使用默认 `start` 命令，执行 1 并发、1 轮采样、简单 prompt 的最小测试。测试完成后，报告会输出到 `results/report-时间戳/`。

## 常用命令

### 查看帮助

```bash
node src/index.js --help
```

### 使用默认命令运行测试

```bash
node src/index.js -c 4 -r 5 -n 0
```

### 显式使用 `start` 命令

```bash
node src/index.js start -c 4 -r 5 -n 2
```

### 使用批次模式

```bash
node src/index.js start -c 2 -r 3 --concurrency-mode batch
```

### 只校验配置，不发请求

```bash
node src/index.js --dry-run
```

### 使用 npm 脚本

```bash
npm run benchmark -- --dry-run
npm run benchmark -- -c 2 -r 2 -n 0
```

注意：当前 `package.json` 里没有 `npm run concurrency` 或 `npm run token-speed`，实际可用的是 `npm run benchmark` 和 `npm start`。

## 参数说明

当前 CLI 只有一个默认测试命令：`start`。

```bash
node src/index.js start [options]

选项:
  -c, --concurrency <number>    并发数，默认读取 DEFAULT_CONCURRENCY 或 4
  -r, --rounds <number>         采样轮数，总采样数 = 并发数 × 轮数
  -n, --sample-count <number>   每次请求随机抽取的样本数量，0 表示使用简单 prompt
  -m, --max-output <number>     最大输出 Token 数
  --concurrency-mode <mode>     并发模式：batch 或 pipeline
  -t, --timeout <seconds>       单次请求超时时间，单位秒
  -u, --url <url>               API 地址，未传时读取 API_BASE_URL
  -k, --api-key <key>           API Key，未传时读取 API_KEY
  --model <model>               模型名，未传时读取 API_MODEL
  --system-prompt <prompt>      自定义 system prompt
  -o, --output <dir>            报告输出目录，默认 `./results`
  -q, --quiet                   静默模式，只输出最终结果
  --dry-run                     仅校验配置，不实际执行请求
```

## 参数选择建议

- 先验证配置：`--dry-run`
- 快速连通性测试：`-c 1 -r 1 -n 0`
- 小规模性能采样：`-c 2 -r 3 -n 0`
- 大上下文测试：`-c 2 -r 3 -n 2`
- 降低接口压力：使用 `--concurrency-mode batch`

## 样本文件

当 `-n` 大于 `0` 时，程序会扫描 `data/` 目录下的 `.txt` 样本，并按文件名规则筛选可用样本。当前仓库里的样本主要位于 `data/samples/`，包含以下类别：

- `data/samples/tech/` - 技术文档样本
- `data/samples/code/` - 代码样本
- `data/samples/dialogue/` - 对话样本
- `data/samples/literature/` - 文学样本
- `data/samples/news/` - 新闻样本
- `data/samples/mixed/` - 混合样本

如果 `-n 0`，则不会读取样本文件，而是使用内置简单 prompt。

## 项目结构

```
├── src/                     # 源代码
│   ├── index.js             # CLI 入口，默认 start 命令
│   ├── llm-benchmark.js     # 测试执行核心
│   ├── context-generator.js # Token 统计与上下文处理
│   ├── http-client.js       # HTTP 请求客户端
│   ├── config.js            # 配置加载
│   └── reporter.js          # 报告生成
├── data/                    # Prompt 与样本目录
│   └── samples/             # 大上下文测试样本
├── docs/                    # 文档与任务记录
├── tests/                   # 测试
└── results/                 # 测试结果输出（gitignored）
```

## 文档

- 测试方法与指标说明：`docs/README.md`
- 环境变量参考：`.env.example`

## License

MIT
