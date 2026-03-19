# LLM API Benchmark

API端点并发能力与Token生成速度测试工具

## 功能特性

- 🚀 **并发测试**: 测试API端点的并发处理能力
- ⚡ **Token速度测试**: 测量LLM API的Token生成速度
- 📊 **详细报告**: 生成详细的性能测试报告（HTML/JSON/Markdown）
- 🔧 **可配置**: 支持多种测试参数配置
- 📝 **多样本支持**: 支持多种类型文本样本（技术文档、对话、文学、代码等）

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，配置你的API端点和认证信息
```

### 运行测试

```bash
# 使用CLI工具运行测试
node src/index.js --help

# 运行并发能力测试
node src/index.js concurrency -c 10 -d 60

# 运行Token生成速度测试
node src/index.js token-speed -c 4 -s 10

# 运行完整测试
node src/index.js all

# 或使用npm脚本
npm run test:concurrency
npm run benchmark
```

### 高级用法

Token速度测试支持多种参数：

```bash
# 使用样本文件进行测试
node tests/llm-benchmark.test.js -c 4 -r 5 -n 2

# 参数说明：
# -c, --concurrency <num>   并发数（默认: 4）
# -r, --rounds <num>         采样轮数（默认: 5）
# -n, --sample-count <num>   每次请求随机抽取的样本数量（默认: 0，使用简单prompt）
# -m, --max-output <num>     最大输出Token数（默认: 30000）
# --concurrency-mode <mode>   并发模式: batch（批次）或 pipeline（流水线）
```

### 样本文件

`data/samples/` 目录下提供了多种类型的样本文件：
- `tech/` - 技术文档样本（sample-8k.txt ~ sample-16k.txt）
- `code/` - 代码样本（code-samples-8k.txt）
- `dialogue/` - 对话样本（conversation-8k.txt）
- `literature/` - 文学样本（novel-8k.txt）
- `news/` - 新闻样本（tech-news-8k.txt）
- `mixed/` - 混合样本（multimodal-8k.txt）

## 项目结构

```
├── src/                    # 源代码
│   ├── index.js            # CLI入口文件
│   ├── benchmark.js        # 基准测试
│   ├── concurrency.js      # 并发测试模块
│   ├── llm-benchmark.js     # LLM基准测试核心
│   ├── context-generator.js # 上下文生成器
│   ├── http-client.js       # HTTP客户端
│   ├── config.js            # 配置管理
│   └── reporter.js          # 报告生成器
├── tests/                  # 测试脚本
│   ├── concurrency.test.js  # 并发测试
│   └── llm-benchmark.test.js # LLM基准测试
├── data/samples/           # 测试样本文件
├── config/                 # 配置文件
├── docs/                   # 文档
└── results/                # 测试结果输出（gitignored）
```

## 文档

详细文档请参阅 [docs/README.md](docs/README.md)

## License

MIT