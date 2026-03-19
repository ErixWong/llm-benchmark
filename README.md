# LLM API Benchmark

API端点并发能力与Token生成速度测试工具

## 功能特性

- 🚀 **并发测试**: 测试API端点的并发处理能力
- ⚡ **Token速度测试**: 测量LLM API的Token生成速度
- 📊 **详细报告**: 生成详细的性能测试报告
- 🔧 **可配置**: 支持多种测试参数配置

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
# 运行所有测试
npm run test:all

# 仅测试并发能力
npm run test:concurrency

# 仅测试Token生成速度
npm run test:token-speed

# 运行性能基准测试
npm run benchmark
```

### 使用自定义输入文件

Token速度测试支持使用自定义文本文件作为输入，适合测试长文本场景：

```bash
# 使用8k文本文件进行测试
node tests/token-speed.test.js --input-file data/sample-8k.txt

# 使用自定义文件并指定其他参数
node tests/token-speed.test.js --input-file data/my-text.txt --samples 5 --concurrency 2
```

`data/` 目录下提供了多个示例文本文件：
- `sample-8k.txt` - 约8k字符的示例文本
- `sample-8k-02.txt` ~ `sample-8k-16.txt` - 多个不同内容的示例文本

## 项目结构

```
├── docs/                    # 文档
│   ├── README.md           # API测试标准文档
│   ├── design/             # 架构设计
│   ├── tasks/              # 任务管理
│   └── tracking/           # 进度跟踪
├── src/                    # 源代码
│   ├── index.js            # 入口文件
│   ├── benchmark.js        # 基准测试
│   ├── concurrency.js      # 并发测试模块
│   ├── token-speed.js      # Token速度测试模块
│   └── reporter.js         # 报告生成器
├── tests/                  # 测试脚本
├── config/                 # 配置文件
└── results/                # 测试结果输出
```

## 文档

详细文档请参阅 [docs/README.md](docs/README.md)

## License

MIT