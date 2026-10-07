# 指标口径与结果判读

本文是压测指标的**权威定义**。工具字段含义以本文为准；变更口径需遵循
[`AGENTS.md`](../AGENTS.md) 的流程（CHANGELOG + `METRICS_VERSION` + 更新本文）。

## 口径定义

| 字段 | 定义 |
|------|------|
| `ttft` | 请求发出 → 收到**首个生成 token**。包含排队、prefill、首个 decode step 与网络往返。**推理模型的 reasoning token 就是第一个 token，因此计入 TTFT** |
| `ttfo` | 请求发出 → 收到首个**可见 content** token（Time to First Output Token）。代表「用户看到第一个字」的延迟 |
| `tps` | 单请求口径：输出 token 数 ÷（首个 token → 最后一个 token 的时长），**不含 TTFT** |
| `throughputTps` | 总输出 token ÷（首个请求发出 → 最后一个响应收到）。**系统级吞吐**，墙钟口径 |
| `errors.rate` | 失败请求数 ÷ 总请求数 |

### 为什么 TTFT 要包含 reasoning token

多个权威来源定义一致：TTFT 的窗口在**第一个 token（不论是否 reasoning）到达时结束**。

- **NVIDIA AIPerf**：TTFT 测「any first token including reasoning tokens」；另设独立指标
  **TTFO** = 首个非 reasoning token。
  <https://docs.nvidia.com/aiperf/reference/ai-perf-metrics-reference>
- **Artificial Analysis**：「For reasoning models which return reasoning tokens, this will be
  the first reasoning token」，另设 *Time to First Answer Token*。
  <https://artificialanalysis.ai/methodology/performance-benchmarking>
- **NVIDIA NIM Metrics**：TTFT = 提交请求到首个收到的 token，含排队 + prefill + 网络。
  <https://docs.nvidia.com/nim/benchmarking/llm/latest/metrics.html>
- **GuideLLM（vLLM 官方推荐的压测工具）**：只认 `delta.content` 导致 TTFT 被放大，
  被列为 `bug / priority-high`。
  <https://github.com/vllm-project/guidellm/issues/737>

把 reasoning 排除在 TTFT 之外还有第二个副作用：TPS 的分子（`completion_tokens`，含 reasoning）
与分母（从 content 起算的窗口）口径不一致，会**系统性高估**推理模型的 TPS。

### 为什么没有「单流 TPS × 并发」这种聚合吞吐

NVIDIA / vLLM / AIPerf 都只有两个吞吐口径：

- 系统级 = 总 token ÷ 墙钟时间
- 单用户级 = 单请求 token ÷ 单请求时延（或 `1/ITL`）

把「单用户 TPS」乘以「客户端并发」来推算系统吞吐，在客户端并发超过服务端实际并行度时会
**严重高估**（实测可达 2 倍以上）。本工具不提供该指标，系统能力一律看 `throughputTps`。

## 口径版本

JSON 报告顶层的 `metricsVersion` 标识口径版本：

| 版本 | 含义 |
|------|------|
| 1.2 | 新增始终存在的 `metrics.diagnostics`，汇总截断与疑似响应级缓存诊断；探针结果继续保留 `metrics.cache` 中的旧诊断字段 |
| 1.1 | 新增可选的 `metrics.cache` 缓存探针结果（含配对判定规则、配对统计与 `reason`） |
| 1.0 | `ttft` = 首个生成 token（含 reasoning）；新增 `ttfo`、`tokenSource`；移除 `decodeThroughputTps` |
| 无该字段 | 旧口径：`ttft` 只统计 content token。**与新数据不可直接对比** |

缓存探针功能与其判定规则均在同一未发布版本内定型，因此不涉及对已发布契约的不兼容变更。

版本使用 `[major].[minor]` 形式：`major` 仅在既有字段含义发生不兼容变更时递增；
`minor` 仅用于纯新增、向后兼容的字段。由于版本号以 JSON Number 保存，`minor` 只能是
`0`–`9` 的单个数字；例如 `1.10` 会被 JSON 数值解析为 `1.1`，不能用作独立版本。

## Token 计数来源

工具默认在请求体中携带 `{"stream_options": {"include_usage": true}}`，
因为 vLLM 等 OpenAI 兼容服务端在流式模式下**默认不返回 `usage`**（遵循 OpenAI 规范）。

| `tokenSource` | 含义 | 精度 |
|------|------|------|
| `api` | 服务端返回 `usage.completion_tokens`；推理 token 取 `usage.completion_tokens_details.reasoning_tokens` | 精确 |
| `tokenizer` | 服务端未返回 usage，用 gpt-tokenizer 对输出文本估算 | **近似** |

两条规则：

1. **不同来源的 token 数不得互相相减**。API 计数用模型自带 tokenizer，客户端计数用
   gpt-tokenizer，两者结果不可比；跨源相减得到的数不对应任何真实计数。
2. 只有当 `completion_tokens` 与 `reasoning_tokens` **同源**（都来自服务端 usage）时，
   `contentTokens = completion_tokens - reasoning_tokens` 才成立；否则 content 与 reasoning
   各自独立计数。

端点不接受 `stream_options` 时可关闭：

```bash
node src/index.js --extra-body '{"stream_options":{"include_usage":false}}'
```

## 缓存命中

压测中的“缓存”可能指三种不同机制，不能混为一谈：

| 类型 | 作用 | 本工具能观测什么 |
|------|------|------------------|
| 前缀缓存 / KV 复用 | 推理服务复用相同 prompt 前缀对应的 KV blocks，减少重复 prefill 工作 | `--cache-probe` 对比 cold/warm 两组 TTFT；服务端若在 usage 中报告缓存 token，也汇总到 `server` |
| API 级 prompt caching | API 服务按其缓存实现复用 prompt，并可能单独报告缓存 token 或计费量 | 只读取响应 usage 中的服务端缓存字段；具体语义由 API 提供方定义 |
| 响应级缓存 | 对相同请求直接复用完整响应，而不是重新推理 | `responseCacheSuspected` 是诊断计数，不是命中证明；输出异常短、无 usage 等信号不能单独证明响应缓存 |

### 通用诊断

JSON 报告在所有运行模式中都提供 `metrics.diagnostics`：

| 字段 | 含义 |
|------|------|
| `truncatedRequests` | 成功请求中，`outputTokens === maxOutputTokens` 的计数；只说明触及配置上限，不证明模型本来自然输出更长 |
| `responseCacheSuspected` | 成功请求中，`contentTokens > 0` 且满足 `outputTokens === 0`、`generationTime === 0`，或本条 `hasUsage === false` 且同次运行至少一条成功请求 `hasUsage === true` 的计数；只是诊断线索，不是缓存命中证明 |

启用 `--cache-probe` 时，`metrics.cache.truncatedRequests` 与
`metrics.cache.responseCacheSuspected` 为兼容保留字段，数值分别与通用口径
`metrics.diagnostics.truncatedRequests` 和 `metrics.diagnostics.responseCacheSuspected`
一致。控制台、Markdown 与 HTML 仅在对应诊断计数大于 0 时显示警告。

当输出 token 中位数小于 5，或全部计时请求都触及 `max_tokens` 上限时，报告与控制台会提示
“输出过短，TPS 不具意义”。TPS 是首个到最后一个生成 token 的窗口均值；输出过短会让该窗口
接近计时分辨率，不能据此比较生成速度。TPS 样本数少于 3 时，汇总展示折叠为一行并标注
“样本不足”，不重复展示缺乏统计意义的 min / median / max。

`tokenSpeed.config` 记录请求超时（`timeout`，毫秒）与经过保留键过滤的 `extraBody`，
便于复现测试配置；API key 不属于报告配置字段，也不会写入报告。Markdown 报告另列
API URL、`-n` 样本数，以及探针单元数、目标前缀长度、`warmupMode`、`runSalt` 与素材库指纹。

开启 `--cache-probe` 后，报告的 `metrics.cache` 结构如下：

| 字段 | 含义 |
|------|------|
| `cold` / `warm` | 两组成功请求的 TTFT 分布摘要：`n`、`median`、`mean`、`min`、`max`；中位数与范围用于描述各组分布 |
| `pairDeltas` | 按 `cacheUnitIndex` 升序的 `warm_i - cold_i`（毫秒）；只包含同一单元中 miss / hit 两侧都有有限 TTFT 的配对，负数表示该对 warm 更快；缺少单元标识的请求不参与配对 |
| `pairsTotal` / `pairsFavorable` / `pairsUnfavorable` / `pairsTied` | 有效配对总数，以及差值分别小于、大于、等于 0 的配对数 |
| `pairedMedianDeltaMs` | `pairDeltas` 的中位数；没有有效配对时为 `null` |
| `ttftDeltaMs` | `cold.median - warm.median`；正数表示 warm 组中位 TTFT 较低，仅作参考，不参与判定 |
| `ttftRatio` | 冷、热中位数均存在且 warm 中位数不为 0 时为 `cold.median / warm.median`；样本不足本身不会令比值为 `null`，若此时可计算则仅供参考、不得据此下结论，是否样本不足看 `insufficientSamples` |
| `insufficientSamples` | cold / warm 任一组有效 TTFT 样本数少于 3，或有效配对少于 3 |
| `server` | 至少一条成功请求上报缓存字段（`cacheSource === "api"`）时为对象，否则为 `null`；可含 `cachedPromptTokens`、`promptTokens`、`tokenHitRate`、`requestsWithData` 与 `source: "api"`。`requestsWithData` 为 0 时对象仍非 null，但 `tokenHitRate` 为 `null` |
| `verdict` / `reason` | 配对证据判定及对应原因码，按下方规则产生 |
| `responseCacheSuspected` | 可疑响应级缓存请求数；仅作诊断线索，非零时控制台与 Markdown / HTML 报告显示警告 |
| `truncatedRequests` | 输出 token 数触及 `max_tokens` 上限的请求数；非零时控制台与 Markdown / HTML 报告显示警告 |

JSON 报告 `tokenSpeed.config.bank` 在题库模式记录题库摘要：`name`、`version`、12 位 SHA-256
内容指纹 `hash` 与题库总条目数 `itemCount`。题库指纹覆盖已解析 JSON 内容（不含派生的 `hash` 字段）。
缓存探针仍沿用其既有 bank 摘要（`name` 与 `hash`）；其 hash 按稳定文件顺序对完整素材文本
（不含运行 nonce / runSalt）计算。

JSON 报告 `tokenSpeed.config` 还记录**输入素材的可复现性**：`sampleSeed`（`--sample-seed`，默认 42）、
`sampleFiles`（排序后的候选文件）与 `sampleSelections`（逐请求选中的文件）。相同素材集 + 相同 seed
+ 相同请求序号 ⇒ 选中相同文件；`-n 0` 时不产生这些字段（不使用文件素材）。**注意**：`-n N` 的选取
口径已于 2026-10 从随机洗牌改为确定性环序轮转，与更早的报告对比时素材可能不同。

`--prefix-tokens` 是客户端 tokenizer 口径的目标值，服务端实际 `prompt_tokens` 可能明显不同（不同 tokenizer 的实测差异可达 30%）；报告中的 `promptTokens` 一律以服务端 usage 为准。两种来源不可混算，沿用“不同来源不得相减”。

JSON 报告的 `raw[]` 新增以下可选逐请求诊断字段（旧报告可能没有这些字段；`cacheIntent` /
`cacheUnitIndex` 仅在缓存探针中有值）：

| 字段 | 含义 |
|------|------|
| `cacheIntent` / `cacheUnitIndex` | 探针请求所属的 miss / hit 意图与单元编号；仅探针请求有值，配对按单元编号而非成功请求过滤后的序位进行 |
| `promptTokens` | 服务端 `usage.prompt_tokens`；服务端未上报时为 `null`。此字段仅用于服务端缓存命中率分母 |
| `inputTokens` | 既有输入 token 数语义：优先使用服务端 `prompt_tokens`，缺失时仍回退客户端 tokenizer 估算 |
| `maxOutputTokens` | 本次请求配置的最大输出 token 上限 |
| `cachedPromptTokens` | 服务端上报的缓存 prompt token 数；没有可用缓存字段时为 `null` |
| `cacheSource` | `api` 表示存在有效的服务端缓存字段；服务端未上报或字段无效时为 `unknown` |
| `hasUsage` | 服务端是否返回 usage；未返回时为 `false` |
| `retries` | 本请求实际发生的客户端重试次数 |
| `bankItemId` | 题库模式下本请求使用的条目 ID；非题库模式下该字段不写入 JSON（缺省），以保持旧报告内容不变 |

题库模式的 `config.bank` 结构为 `{name, version, hash, itemCount}`。`raw[].bankItemId` 指向本次请求
prompt 来源的题库条目；显式 `--bank-items` 选择时同样记录实际分配的 ID。无题库模式下不序列化
`bankItemId`，而不是写 `null`。

口径规则：

1. **缓存命中率只依据服务端 usage**。`server` 非 null 当且仅当至少一条成功请求上报缓存字段
   （`cacheSource === "api"`）；`requestsWithData` 只计入缓存字段与服务端 `prompt_tokens`
   都可用的请求。若 `requestsWithData === 0`，`tokenHitRate` 为 `null`，verdict 不按服务端
   数据判定而走配对行为分支。服务端未上报缓存字段时 `server` 为 `null`。绝不使用客户端
   tokenizer 或冷热延迟估算命中率。服务端有 usage 但**不含缓存字段**时，命中率是 unknown，
   不能按 0 处理；只有服务端**显式**返回 `cached_tokens: 0`（或等价字段为 0）且有可用
   `prompt_tokens` 时，才汇总为 `tokenHitRate: 0`。
2. 配对规则遵循 `buildRequestPlan` 契约：成功请求按 `cacheUnitIndex` 分组，同一单元必须各有
   一条 `cacheIntent` 为 miss / hit 的请求，且两侧 TTFT 都是有限数值，才计入 `pairDeltas`；
   缺少 `cacheUnitIndex` 的请求不配对。差值定义为 `warm_i - cold_i`。
3. **判定使用配对差值，而不是冷热组中位数比较**：探针是配对实验，每个单元的 cold/warm
   除 nonce 外共享相同前缀和内容；`warm_i - cold_i` 可抵消服务器随时间发生的性能漂移。
   **逐对差值符号不一致时不下收益结论**。`ttftDeltaMs` / `ttftRatio` 仍保留作分布参考，
   不参与 verdict 判定。TTFT 包含排队、prefill（如未命中）、首个 decode step 和网络往返，
   不是 prefill 耗时；不设置固定的毫秒差或倍数验收阈值。
4. `verdict` 按以下顺序产生：
   - 任一冷热组有效 TTFT 样本数少于 3，或 `pairsTotal < 3`：`inconclusive`，
    `reason: "insufficient-samples"`。
   - 服务端非 null、`requestsWithData > 0` 且 `tokenHitRate === 0`：
    `no-benefit`，`reason: "server-reports-zero"`。
   - `pairsUnfavorable === 0`、`pairsTotal > 0` 且 `pairedMedianDeltaMs < 0`：
    `benefit`，`reason: "consistent-benefit"`。
   - 其余情况，若服务端有数据且 `tokenHitRate > 0`：`inconclusive`，
    `reason: "inconsistent-pair-deltas"`；否则为 `no-benefit`，
    `reason: "no-consistent-benefit"`。
5. `reason` 取值表：

   | `reason` | 含义 |
   |----------|------|
   | `insufficient-samples` | 冷热组有效 TTFT 样本或有效配对不足 3 |
   | `server-reports-zero` | 服务端有完整数据且明确报告零缓存命中 |
   | `consistent-benefit` | 配对差值没有反向配对，且其中位数为负 |
   | `inconsistent-pair-deltas` | 服务端报告命中，但配对证据不一致，不能确认收益 |
   | `no-consistent-benefit` | 没有服务端正命中证据，也没有一致的配对收益 |
6. 命中率只在同一服务端数据源、同一 token 口径内计算（缓存 prompt token 总数 ÷ prompt token
   总数）。沿用“不同来源不得相减”的规则，不把客户端估算值与服务端 usage 混算。

测量前置条件与陷阱：

- **前缀必须逐 token 一致**：字符相似、语义相同或仅有空白差异，都可能产生不同 token 序列，
  造成假阴性。system prompt、模板和服务端预处理变化也可能改变实际 token 前缀。
- **nonce 必须放在所有共享内容之前**。cold/warm 的 nonce 不同；若 nonce 放在共享素材后面，
  cold 请求仍以前面共享内容开头，可能意外命中。
- **前缀预热必须串行**：同一待测前缀的并发预热可能形成惊群，多个请求同时首次到达时都会 miss。
  本工具的 prefix 预热按单元串行执行，并在计时请求之前完成。
- **模型预热不替代前缀预热**：探针使用 `--warmup-mode model` 时先发送唯一 nonce 的模型/JIT
  预热请求，然后仍会串行 priming 所有待测前缀；探针不能使用 `--warmup-mode none`。
- **服务器性能漂移**：请求越晚越慢等时变因素会污染两组 TTFT 中位数比较。一次 vLLM 实测中
  `prefix_cache_hits_total` 增量为 0，但 cold 为 `[772, 1686, 2202] ms`、warm 为
  `[760, 986, 2707] ms`；组中位数分别为 `1686 ms` / `986 ms`，旧规则会误判收益。
  配对差值实际为 `[-12, -700, +505] ms`（2 对有利、1 对反向），符号不一致，因此新规则
  不判定收益。配对差值可抵消部分共同漂移，但不会消除所有噪声。
- **缓存按 block 粒度工作**：例如 vLLM 默认 block size 为 16 tokens，实际命中 token 数会按 block
  向下取整；短前缀或 block 边界附近的差异可能看起来不像逐 token 精确匹配。
- **并发会产生淘汰**：并发大于 1 时，cold 组的大前缀可能挤掉已预热的 warm 前缀。
  因此命中率低于 100% 可能是被测服务缓存容量/调度的真实测量结果，不是工具错误。
- **假阴性防护**：任何前缀自检（包括 hash 自检，如检测到摘要不匹配）失败时都必须报错中止，
  不得继续给出缓存结论。运行时自检检查文本唯一性、warm 是否以前缀原文开头，以及重新计算
  `primed` 文本的 hash 和 token 数是否与记录值一致。
  `prefixHash` 是客户端摘要，不是服务端缓存命中的证明。
- 探针预热会改变服务端缓存状态；只对获准的测试端点运行，不要对生产服务做未经授权的压力测试。

## 推理模型（GLM / Qwen / DeepSeek-R1 等）

- 同时兼容 `delta.reasoning` 与 `delta.reasoning_content` 两种字段名
- `ttft` 在第一个 reasoning token 到达时停止；`ttfo` 记录第一个可见 content token
- **`--max-output` 要给够**：思考模式下该值太小会导致输出全被思考占满、一个答案 token 都没有。
  症状是 `ttfo` 为空、`contentTokens` 为 0，此时测到的只是思考阶段的解码速度，
  **不是**用户可感知的答案延迟
- 关闭思考模式（vLLM 部署）：

```bash
node src/index.js --extra-body '{"chat_template_kwargs":{"enable_thinking":false}}'
```

## 并发扩展性怎么判读

健康的扩展曲线：并发上升 → `throughputTps` 持续上升，`ttft` 缓慢上升。

**饱和特征**：`throughputTps` 平台化，而 `ttft` 与端到端时延持续上爬。
这说明客户端并发已超过服务端实际并行度（例如 vLLM 的 `max_num_seqs`），
多出来的请求只在排队。此时：

- **可信**：`throughputTps`（墙钟吞吐）——它反映服务端真实能力
- **不可信**：单请求 `tps`。因为排队时间落在 TTFT 窗口内、被排除在解码窗口之外，
  即使服务端已过载，单请求 TPS 也会看起来「没有下降」

要确认服务端实际并行度，应对照服务端自身指标（如 vLLM `/metrics` 的
`num_requests_running` / `num_requests_waiting`），而不是从客户端反推。

## 测量前置条件与常见陷阱

| 条件 | 说明 |
|------|------|
| **网络往返** | RTT 直接计入 `ttft`。跳地域、跳网关压测时，`ttft` 反映的是链路而不是服务端 prefill。要与厂商公布数字对比，必须在同机房或本地回环 |
| **输入分布** | 用 `-n` 拼接与线上量级一致的上下文。内置简单 prompt 只能做连通与上限观测，**不代表服务能力** |
| **前缀缓存** | 固定输入反复压同一服务端会命中 prefix cache，吞吐可虚高数成。干净数据需换输入或清服务端缓存 |
| **预热** | 工具默认发 1 次预热请求且不计指标；但首轮仍可能有编译/编译抖动，重要对比建议 `-r` 加大 |
| **样本量** | 工具只报 mean / median / min / max，**没有 P90/P99**。`-r 5` 这种小样本下分位数无统计意义；要看长尾就用 median 对比 max，并增大 `-r` |
| **验收阈值** | 不要用 REST API 的「P90 < 200ms 算优秀」这类阈值判 LLM：LLM 的 TTFT 天然在数百毫秒到数秒量级，且与输入长度、是否思考模式强相关。只能做同模型、同输入长度、同并发下的**相对**比较 |
| **原始数据** | JSON 报告的 `raw` 是逐请求明细。历史趋势对比应基于它重算，而不是只留摘要里的平均数字 |

## 范围边界（本工具不做的事）

| 不做 | 用什么 |
|------|------|
| 按持续时间 / rampUp 的加压曲线（本工具按「并发 × 轮数」离散发请求） | AIPerf、guidellm、k6 |
| RPS/QPS 与 P50/P90/P99 分位数 | 用 `raw` 里的 `requestTime` 自行计算，或用上述工具 |
| 服务端资源指标（GPU 利用率、显存、KV cache 命中、排队深度） | vLLM `/metrics`、Prometheus + Grafana |
| 多轮会话接续、真实会话回放与 agentic 流程（会话与 agent 能力不在本工具 scope） | 专用会话/agent 评测与回放工具 |
| 浸泡 / 峰值 / 混沌类测试 | 专用平台；本工具单次运行以秒到分钟计 |

## 与其他工具的字段对照

| 本工具 | NVIDIA AIPerf | `vllm bench serve` |
|--------|---------------|--------------------|
| `ttft` | `time_to_first_token` | Mean/Median TTFT |
| `ttfo` | `ttfo`（Time to First Output Token） | — |
| `tps` | `output_token_throughput_per_user`（`1/ITL`） | — |
| `throughputTps` | `output_token_throughput` | Output token throughput |
| `outputTokens`（含 reasoning） | `output_sequence_length` | Total generated tokens |
| `reasoningTokens` | `reasoning_token_count` / `usage_reasoning_tokens` | — |
| `contentTokens` | `output_token_count` | — |
| —（**未实现**） | `inter_token_latency` | ITL / TPOT |

> 本工具不提供 **ITL**（token 间延迟）。单请求 `tps` 只是 ITL 的窗口均值倒数，
> 无法反映 token 间的抖动（首包后的 burst、解码中的卡顿）。需要 ITL 请用 AIPerf 或 guidellm。
>
> 各家工具的名词并不统一，**比较结果前先对齐定义**，不要只看名字。
