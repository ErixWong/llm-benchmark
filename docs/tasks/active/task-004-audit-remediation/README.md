# Task-004: 审计问题修复

## 目标

根据最新代码审计结果，修复影响 benchmark 结果可信度、配置行为一致性和维护性的核心问题。

## 范围

1. 修复 TPS、TTFT、token 统计和时间线展示中的不合理计算
2. 收敛配置加载、参数校验和并发模式的实际行为
3. 清理报告层死代码、失效脚本和与当前实现不一致的文档
4. 为核心统计与参数行为补充测试，确保回归可验证

## 受影响文件

- `src/llm-benchmark.js`
- `src/context-generator.js`
- `src/index.js`
- `src/http-client.js`
- `src/reporter.js`
- `src/config.js`
- `tests/*.test.js`
- `.env.example`
- `CHANGELOG.md`
- `docs/README.md`
- `docs/CODE_AUDIT_CHECKLIST.md`
- `scripts/adjust-tokens.js`

## 执行顺序

1. 先修结果口径问题，避免继续生成误导性 benchmark 数据
2. 再修配置和参数路径，统一 CLI 实际行为
3. 然后清理文档和脚本中的历史残留
4. 最后补测试并跑验证

## 状态

⏳ 进行中

## 创建日期

2026-07-05
