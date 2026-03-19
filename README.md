# LLM API Benchmark

API端点并发能力与Token生成速度测试工具

## 功能特性

- 🚀 **并发测试**: 测试API端点的并发处理能力
- ⚡ **Token速度测试**: 测量LLM API的Token生成速度
- 📊 **详细报告**: 生成详细的性能测试报告（HTML/JSON/Markdown）
- 🔧 **可配置**: 支持多种测试参数配置
- 📝 **多样本支持**: 支持多种类型文本样本（技术文档、对话、文学、代码等）
- 🔄 **并发模式**: 支持批次(batch)和流水线(pipeline)两种并发模式

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
# 查看帮助
node src/index.js --help

# 运行并发能力测试
node src/index.js concurrency -c 10 -d 60

# 运行Token生成速度测试
node src/index.js token-speed -c 4 -r 5 -n 2

# 运行完整测试
node src/index.js all

# 或使用npm脚本
npm run concurrency
npm run token-speed
npm run benchmark
```

## 命令详解

### concurrency - 并发能力测试

```bash
node src/index.js concurrency [options]

选项:
  -c, --concurrency <number>   并发数 (默认: 10)
  -d, --duration <seconds>     测试持续时间(秒) (默认: 60)
  -r, --ramp-up <seconds>      预热时间(秒) (默认: 10)
  -u, --url <url>              API端点URL
  -k, --api-key <key>          API密钥
  -m, --model <model>          模型名称 (默认: gpt-3.5-turbo)
  -o, --output <dir>           输出目录 (默认: ./results)
```

### token-speed - Token生成速度测试

```bash
node src/index.js token-speed [options]

选项:
  -c, --concurrency <number>       并发数 (默认: 4)
  -r, --rounds <number>            采样轮数，总采样数 = 并发数 × 轮数 (默认: 5)
  -n, --sample-count <number>      每次请求随机抽取的样本数量 (默认: 0，使用简单prompt)
  -m, --max-output <number>        最大输出Token数 (默认: 30000)
  --concurrency-mode <mode>        并发模式: batch(批次) 或 pipeline(流水线) (默认: pipeline)
  -t, --timeout <seconds>          请求超时时间(秒) (默认: 90)
  -u, --url <url>                  API端点URL
  -k, --api-key <key>              API密钥
  --model <model>                  模型名称 (默认: gpt-3.5-turbo)
  --system-prompt <prompt>         系统提示词
  -o, --output <dir>               输出目录 (默认: ./results)
```

### 示例

```bash
# 并发4，轮数5，共20次采样，每次抽取2个样本
node src/index.js token-speed -c 4 -r 5 -n 2

# 使用批次模式进行测试
node src/index.js token-speed -c 2 -r 3 --concurrency-mode batch

# 设置超时时间为120秒
node src/index.js token-speed -c 4 -r 5 -t 120
```

## 样本文件

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
│   ├── llm-benchmark.js    # LLM基准测试核心
│   ├── context-generator.js # 上下文生成器
│   ├── http-client.js      # HTTP客户端
│   ├── config.js           # 配置管理
│   └── reporter.js         # 报告生成器
├── data/samples/           # 测试样本文件
├── config/                 # 配置文件
├── docs/                   # 文档
└── results/                # 测试结果输出（gitignored）
```

## 文档

详细文档请参阅 [docs/README.md](docs/README.md)

## License

MIT