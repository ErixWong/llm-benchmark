# Task-002: 修复 Benchmark 配置传递问题

## 目标
修复 `npm run benchmark` 命令没有正确传递 `.env` 配置的问题。

## 问题分析
1. `all` 命令没有传递 `model` 参数，导致使用了默认值 `gpt-3.5-turbo`
2. 多处代码使用硬编码默认值，而不是在缺少必填参数时报错

## 修复内容
1. **src/index.js**:
   - `concurrency` 命令：移除 model 默认值，添加必填检查
   - `token-speed` 命令：移除 model 默认值，添加必填检查
   - `all` 命令：添加 model 参数传递和必填检查

2. **src/concurrency.js**:
   - 移除 model 默认值
   - 添加 model 必填检查

3. **src/llm-benchmark.js**:
   - 移除 model 默认值
   - 添加 model 必填检查

## 测试结果
- 模型：glm-5 ✅
- 并发测试：完成（429 限流错误较多，API 限制）
- Token速度测试：成功
  - 平均 TPS：47.85 tokens/s
  - 平均 TTFT：7075.64 ms
  - 错误率：0%

## 状态
✅ 已完成