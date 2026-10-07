# 工程约定（AGENTS.md）

面向在本仓库工作的工程师与自动化代理。

## 项目定位

LLM API 压测 CLI：针对 OpenAI Chat Completions 兼容端点，测量 token 生成速度、TTFT/TTFO、
吞吐与成功率，产出 JSON / Markdown / HTML 报告。

- 运行时：Node.js >= 18，ESM（`"type": "module"`），无构建步骤、无打包产物
- 入口：`src/index.js`（commander，默认子命令 `start`）
- 测试：`vitest`，用例位于 `tests/`

## 常用命令

```bash
npm install                    # 安装依赖
npx vitest run                 # 运行全部测试
node src/index.js --dry-run    # 只校验配置，不发请求
node src/index.js start -c 1 -r 3 -n 0 -m 256
npm run benchmark              # 等价于 node src/index.js
```

## 模块职责

| 文件 | 职责 |
|------|------|
| `src/index.js` | CLI 入口、参数解析、样本扫描 |
| `src/llm-benchmark.js` | 压测执行核心：并发调度、流式解析、指标聚合、控制台输出 |
| `src/token-stats.js` | 完成 token 口径（服务端 usage 优先，客户端 tokenizer 回退） |
| `src/extra-body.js` | `--extra-body` 解析与保留键保护 |
| `src/context-generator.js` | 输入上下文生成与 token 计数 |
| `src/http-client.js` | axios 实例：keep-alive、重试、超时、URL 规范化 |
| `src/reporter.js` | 报告生成（JSON / Markdown / HTML）与转义 |
| `src/cache-source.js` | 探针素材构造：按标题边界切片、前缀/后缀拼装、素材库指纹 |
| `src/cache-plan.js` | 探针请求计划：按种子环序选取单元文档、生成 cold/warm 计划 |
| `src/cache-probe.js` | 探针编排：运行盐、冷/热单元构造、前缀唯一性校验与前置检查 |
| `src/cache-stats.js` | 探针统计与诊断纯函数：服务端缓存 usage、截断/疑似响应缓存诊断、冷热配对判定 |
| `src/sample-select.js` | `-n N` 的确定性样本选取（seeded 环序轮转） |

## 硬性约定

1. **测试先行**：改动 `src/` 后 `npx vitest run` 必须全绿才能提交。
2. **新逻辑写成小的纯函数模块并配单测**，不要在 CLI 或报告生成器里堆逻辑。
   参考样板：`src/token-stats.js`、`src/extra-body.js` 及其测试。
3. **`docs/` 只放设计、架构、用法文档。** 压测结果、报告产物、审计记录一律不得进入
   `docs/`：结果类归 `results/`（已 gitignore），任务与流程记录归 `docs/tasks/`
   （本地工作区，已 gitignore）。
4. **`docs/tasks/` 下的历史任务不做修订**，只读归档。
5. **指标口径是契约。** 任何对外字段含义的变更必须同时做到：
   (a) 在 `CHANGELOG.md` 记录并标注 BREAKING；
   (b) 递增 `src/reporter.js` 中的 `METRICS_VERSION`；
   (c) 更新 `README.md` 的「指标口径」章节。
6. **口径以业界标准为准，引定义而非引名字**：NVIDIA AIPerf Metrics Reference、
   `vllm bench serve`、Artificial Analysis 方法论。名字冲突时以定义为准。
7. **不引入未被文档化的外部行为依赖**。若请求体新增字段（如 `stream_options`），
   必须在 README 写明作用与关闭方式。
8. **密钥不落库**：`.env` 已 gitignore；报告默认不包含模型输出全文
   （`REPORT_INCLUDE_TEXT=true` 才包含）。
9. **压测会改变被测端状态**：不得对生产端点发起压力测试或未经授权的推理请求。

## 分支与提交

- 分支命名：`{type}/{编号}-{简短描述}`，`type ∈ feat | fix | refactor | docs | chore`
- 从 `main` 创建，完成后合并回 `main`
- 提交信息：`{type}: {描述}`（历史提交带 `[T{编号}]` 前缀，新提交可选）
- `CHANGELOG.md` 遵循 Keep a Changelog；未发布的改动累积在 `[Unreleased]` 下
- 一个提交只做一件事；无关改动（如锁文件重生成）单独处理或还原

## 审查清单

- [ ] `npx vitest run` 全绿
- [ ] 指标口径是否变化？变了是否走了第 5 条流程
- [ ] 是否新增对外部服务的隐式依赖？是否已写明回退方式
- [ ] 新增的纯逻辑是否有单测覆盖
- [ ] 报告三个产物（JSON / Markdown / HTML）是否都能正常生成
- [ ] README 与 `.env.example` 是否与代码实际行为一致
- [ ] 是否有密钥、内网地址、生产运维细节进入将入库的文件
