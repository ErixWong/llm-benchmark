# Task-006: 审计修复计划

## 目标

根据 `task-005` 审计结论，将 `src/`、`tests/`、`scripts/` 范围内的高风险问题拆解为可执行修复计划，明确优先级、影响范围、验收标准和实施顺序。

## 修复范围

- `src/llm-benchmark.js`
- `src/reporter.js`
- `src/context-generator.js`
- `src/http-client.js`
- `src/index.js`
- `tests/`
- `scripts/count-tokens.js`
- `scripts/adjust-tokens.js`

## 修复优先级

### P0 - 结果可信度

1. [x] 修复 SSE 尾部 buffer 未冲刷的问题
2. [x] 修复 `generationTime === 0` 时的 TPS 计算与加权均值污染
3. [x] 为上述两类边界补充针对性测试

### P1 - 报告一致性

1. [x] 修复 Markdown 报告使用报告生成时间而非测试执行时间
2. [x] 统一 Markdown / HTML 中 TTFT 的单位和解释口径
3. [x] 修复图表只展示成功请求导致的请求序列跳号问题
4. [x] 修复全失败场景下 Markdown 报告缺少失败摘要的问题
5. [x] 为 `reporter.js` 增加最小可回归测试覆盖

### P2 - token 统计与口径说明

1. [x] 兼容 `usage` 与 `timings` 两类服务端 token 元信息
2. [x] 细化 `tokenSource` 为 `api-usage` / `api-timings` / `tokenizer`
3. [ ] 修复动态输入模式下 config 层只记录首次输入 token 的误导问题

### P3 - 脚本与维护性

1. [x] 修复 `scripts/count-tokens.js` 仍扫描旧目录结构的问题
2. [x] 校验 `scripts/adjust-tokens.js` 与当前样本筛选规则的一致性
3. [x] 为 `scripts/` 目录补充 README，并执行最小 smoke test

### P4 - 资源与错误路径健壮性

1. [x] 评估并修复流错误路径事件监听器未清理的问题
2. [x] 评估动态样本读取在高并发下的文件系统压力
3. [x] 审核预热阶段对非 HTTP 错误直接忽略的策略是否需要收紧
4. [x] 修复动态样本模式下预热请求误用样本文本的问题

## 实施顺序

1. 先处理 `P0`，保证 benchmark 结果可信
2. 再处理 `P1`，保证报告解释不误导用户
3. 然后处理 `P2`，统一 token 统计策略
4. 最后处理 `P3` / `P4`，收掉脚本与健壮性问题

## 验收标准

1. 所有关键修复均有对应测试覆盖
2. `npm test` 全量通过
3. Dry-run 和最小 benchmark 流程不回归
4. JSON / Markdown / HTML 三种报告的关键指标口径一致
5. `scripts/count-tokens.js` 与 `scripts/adjust-tokens.js` 都能在当前目录结构下正常工作

## 风险说明

- tokenizer 策略涉及“统一口径”与“模型精度”之间的取舍，可能需要单独设计决策
- 图表修复可能牵涉报告 JSON 结构的轻微调整，需要同步测试
- 高并发样本读取优化可能影响当前 benchmark 行为，需要谨慎验证

## 关联任务

- `task-005-project-audit-plan`

## 状态

⏳ 进行中（P0 / P1 / P3 / P4 已完成，P2 还剩输入 token 分布问题）

## 最新进展

- 2026-07-07：修复 `src/llm-benchmark.js` 中预热请求在动态样本模式下错误复用 `generateInputText()` 的问题
- 当前行为改为：预热阶段固定使用简单 prompt，正式采样阶段继续按 `sampleCount` 动态抽样
- `tests/llm-benchmark.test.js` 已补回归测试，覆盖“预热简单模式 + 正式请求样本模式”的分流逻辑

## 创建日期

2026-07-05
