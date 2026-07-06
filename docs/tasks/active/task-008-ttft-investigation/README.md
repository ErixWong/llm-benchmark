# Task-008: TTFT 排查记录

## 目标

核对 `results/report-2026-07-06_20-54-14/benchmark-2026-07-06_20-54-14.html` 中展示的 `TTFT` 是否存在计算错误，并追踪原始数据与代码口径。

## 检查范围

- `results/report-2026-07-06_20-54-14/benchmark-2026-07-06_20-54-14.html`
- `results/report-2026-07-06_20-54-14/benchmark-2026-07-06_20-54-14.json`
- `results/report-2026-07-06_20-54-14/benchmark-2026-07-06_20-54-14.md`
- `src/llm-benchmark.js`
- `src/reporter.js`

## 现象

- HTML 报告显示平均 `TTFT` 为 `76.17 s`
- 同一份报告显示总测试时间约 `4.5 分钟`
- 测试配置为 `并发 4`、`流水线`、`采样 8`
- 直观看，`76 s` 的首 token 延迟偏大，容易怀疑报告层二次计算有误

## 证据

1. 报告层未重算 TTFT，仅将聚合结果按毫秒转秒显示
   - `src/reporter.js` 中摘要与指标卡均直接使用 `tokenSpeed.metrics.ttft.mean`
   - HTML 中的 `76.17s` 来自 `${(r.metrics.ttft.mean / 1000).toFixed(2)}`

2. 原始 JSON 中的聚合值与页面一致
   - `metrics.ttft.mean = 76171.5`
   - `metrics.ttft.min = 37828`
   - `metrics.ttft.max = 141603`
   - `metrics.ttft.values = [60986, 81223, 76088, 141603, 73022, 93799, 44823, 37828]`

3. 单请求数据内部自洽
   - 每条成功记录均满足 `ttft + generationTime = totalRequestTime`
   - 例如首条记录：`60986 + 26246 = 87232`
   - 最慢记录：`141603 + 74971 = 216574`

4. 采集逻辑口径明确
   - `src/llm-benchmark.js` 中 `ttft = firstTokenTime - requestStart`
   - `requestStart` 在真正发起 `httpClient.post(...)` 之前记录
   - `firstTokenTime` 在收到首个 `delta.content` 或 `delta.reasoning` 时记录
   - 这意味着 TTFT 包含服务端排队、prefill、reasoning 首包前等待，但不包含客户端流水线调度中的“尚未发出请求”时间

5. 流水线调度没有把跨批次等待误算进 TTFT
   - 前四个请求的 `requestSendTime` 几乎同时开始
   - 后续请求都在前一批某个请求完成后才启动，时间戳连续且合理
   - `requestSendTime` 来源于单次 `measureTokenSpeed` 内部，不是外部排队时间

## 结论

- 这份报告里的 `TTFT` 数值看起来偏大，但当前证据不支持“HTML 报告把 TTFT 算错了”这个判断
- 更准确的结论是：报告如实展示了采集结果，而采集口径本身把“请求发出到首个 reasoning/content token 到达”的全部等待时间都算进了 `TTFT`
- 对于 `qwen3.6:35b`、`约 4.8k 平均输入 token`、`并发 4`、`最大输出 10000` 的场景，这个口径下出现 `37s` 到 `141s` 的 TTFT 虽然偏慢，但并非与原始记录矛盾

## 风险与解释

- 如果服务端先进行长时间预填充或思维链计算，再开始流式输出，TTFT 会显著变大
- 当前实现把 `delta.reasoning` 也视为“首 token”，因此这份结果不是“首个可见正文 token”之前的纯展示延迟
- 当前报告已经另外展示了 `首可见Token TTFT`，但这次结果中它与 `TTFT` 完全相同，说明服务端首个流式片段就是可见内容或两者同一时刻到达

## 后续建议

1. 若要判断“值大不大”而不是“算没算错”，应结合服务端日志确认首包时间、排队时间、prefill 时间
2. 若要增强报告可解释性，可额外展示 `TTFT / totalRequestTime` 占比，或在 JSON 中显式记录 `queue/prefill/generation` 分段（前提是服务端提供）
3. 若想排除 `delta.reasoning` 对 TTFT 的影响，可增加一个仅以 `delta.content` 为准的严格正文首 token 指标

## 补充验证（2026-07-06 21:27 报告）

- 对 `results/report-2026-07-06_21-27-34/benchmark-2026-07-06_21-27-34.json` 的最后一个请求（`requestIndex = 7`）复核后发现：
  - benchmark 记录：`totalRequestTime = 83720 ms`、`ttft = 48760 ms`
  - LiteLLM 观测：`duration = 82.36 s`、`ttft = 2.49 s`
- 两边的总时长高度接近，说明请求生命周期整体没有严重漂移
- 但首 token 延迟相差约 `46.27 s`，说明问题不在“请求起点”，而在“首 token 到达判定”
- 这进一步支持如下判断：服务端较早已经开始返回流数据，但旧版解析逻辑没有把那一段数据识别为 token
- 在这种情况下，旧报告中的 `generationTime` 会被压短，`request tps` / `weighted mean tps` 会被抬高

## 已实施修复

1. 调整 `src/llm-benchmark.js` 中的流式 delta 归一化逻辑
   - 不再使用 `delta.reasoning || delta.reasoning_content` 的短路写法
   - 改为分别归一化 `reasoning` 与 `reasoning_content` 后再拼接，避免“字段存在但为空容器”时漏掉真正的首 token

2. 扩展数组型 delta 文本提取
   - 数组元素不再只读取 `item.text`
   - 额外支持 `delta`、嵌套 `content`、`reasoning`、`reasoning_content` 等常见字段

3. 增加回归测试
   - `reasoning_content` 先于正文返回
   - `reasoning` 为空数组但 `reasoning_content` 已有内容
   - 数组型 `content` 使用 `text` 字段
   - 数组型 `content` 使用 `delta` 字段

## 当前结论

- 这次修复解决了审计中已确认的两类解析缺口，能够避免多种常见 SSE 增量格式被漏记
- 由于现有结果目录中的报告均生成于修复前，不能用旧报告验证修复效果
- 要确认是否完全命中你的线上场景，仍需用修复后的代码重跑同条件 benchmark，并对照 LiteLLM 的 `duration/ttft`

## 状态

已完成排查，当前结论为“口径偏重，不是页面算错”。

## 创建日期

2026-07-06
