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
| 1 | `ttft` = 首个生成 token（含 reasoning）；新增 `ttfo`、`tokenSource`；移除 `decodeThroughputTps` |
| 无该字段 | 旧口径：`ttft` 只统计 content token。**与新数据不可直接对比** |

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

> 各家工具的名词并不统一，**比较结果前先对齐定义**，不要只看名字。
