---
description: "面向选择 Codex 作为完整 DSH 循环的用户，以及维护其持久 thread 与事件映射的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

`dsh-agent-codex` 把持久 Codex app-server thread 作为 DSH `Agent` 驱动。Codex 拥有模型历史、推理、原生工具、shell 与文件系统工作；DSH 拥有发布、持久化、UI/审计投影，以及到 Codex thread 的持久映射。provider 在现有 `agent-loop` 生命周期工厂下注册 `codex` driver，因此普通 agent 与 Codex agent 可以共存于同一进程。

`codex.enabled` 默认为 `false`。在「设置 → 插件 → 插件配置」中，Codex 卡片保存这个开关与可选的 `label`。启用后，所选 `provider/model` 同时列在 `codex.providers` 中的新会话使用 Codex 驱动；关闭后，该路由使用标准 agent 循环。空白的标准会话显式选择 Codex 模型时可以切换到 Codex；开始一个 turn 后，切换驱动需要新会话。持久化的 Codex thread binding 即使在开关关闭后也通过 Codex 恢复。每个已配置的 Codex provider 都显示为独立的模型选择组，名称为 `<label>: <provider 显示名>`；未配置 `label` 时使用 agent 键 `codex`。模型名称也带同样的 agent 前缀。`codex` 驱动路由仍可用，但不产生重复的模型选择组。

## 使用本包

安装本包的 profile patch，并使用已配置的 `codex:<provider>` 路由创建 agent。本部署的 DSH Codex driver 关闭 Codex 原生沙箱，依靠 Docker 容器作为执行边界。

```yaml
- name: '@deepseek-ai/dsh-agent-codex'
  config:
    cwd: /absolute/default/workspace
    approvalPolicy: never
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cwd` | Host 工作目录 | app-server 进程 cwd，以及会话没有持久 cwd 时的后备目录 |
| `approvalPolicy` | `never` | Codex 原生审批策略 |
| `disposeGraceMs` | `3000` | 进程树关闭宽限时间 |
| `turnTimeoutMs` | `0` | 每轮超时毫秒数；零表示禁用 |
| `env` | `{}` | DSH 共享凭据清理之后有意添加的环境变量层 |
| `enabled` | `false` | 为匹配的新会话自动选择 Codex |

通过普通 registry 创建 agent，并用 provider route 选择 driver：

```ts
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: '/absolute/workspace' },
  agentOptions: { provider: 'codex:llm_proxy', model: 'llm_proxy/qwen3.8-27b' },
})
```

插件使用部署自有的 Codex fork 二进制（`DSH_CODEX_BIN`；DSH 镜像中为 `/opt/codex/bin/codex`）与官方 `codex app-server --stdio` 协议。`DSH_CODEX_REVISION` 会与协议版本一起持久化到 thread binding；它不搜索 `PATH`，不解析 npm Codex 包，也不解析终端文本。

完整 Codex agent 的模型位于独立的 `codex` settings section。provider profile 的形状有意与 `llm-pi-ai` 相同，但采用复制而非继承，因此修改一个 agent family 不会静默改变另一个。`apiFormat` 可省略，默认值为 `chat-completions`。

```yaml
codex:
  label: Codex
  enabled: true
  providers:
    llm_proxy:
      apiKeyEnv: LLM_PROXY_API_KEY
      baseURL: http://llm-proxy:9090
      models:
        - id: qwen3.8-27b
          name: qwen3.8-27b
```

所选 Codex 模型 id 为 `llm_proxy/qwen3.8-27b`；模型选择器在 `Codex: llm_proxy` 组下提供该模型，路由为 `codex:llm_proxy`。Codex 始终通过 Responses 与一个经过认证的 loopback gateway 通信。使用默认格式时，gateway 会把 message、function tool、tool result、流式文本、流式 function call、usage 与 error 适配为 OpenAI-compatible Chat Completions。使用 `apiFormat: responses` 时，它会代理原生 Responses request 与 SSE stream，只替换路由后的模型 id 和上游认证信息。

在 Docker 的 `.env` 中设置 `CODEX_LOG_REQUESTS=true` 后，每次通过认证的 Codex-to-gateway 交互会保存为四个带相同时间戳/UUID 前缀的 JSON 文件：`_input_headers.json`、`_input_body.json`、`_output_headers.json` 和 `_output_body.json`；默认不记录。生产实例挂载 `../volumes/codex-requests`，测试实例挂载 `../volumes/codex-requests-test`。记录的是 gateway request 与 response，而不是转换后的上游 Chat Completions payload。输出 body 包含原始 response 文本以及标示中断流的 `complete` 字段。认证 header 会被遮蔽，但 prompt 和 tool 内容可能包含秘密；应保护该 volume，并在不需要时关闭记录。

DSH Codex driver 始终以 `danger-full-access` 启动 thread；审批策略默认是 `never`。它不调用 Codex 的 Linux `bubblewrap` 沙箱。Docker 仍限制容器，但容器挂载的文件、环境中的凭据及可访问的网络服务仍可被 agent 使用。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/provider.ts`](src/provider.ts) | settings 所有权、模型目录、driver 注册与 runtime 生命周期 |
| [`src/model-gateway.ts`](src/model-gateway.ts) | 认证 Responses gateway、Chat Completions adapter 与原生 Responses proxy |
| — | 不发布 runtime invariant companion；schema 校验与聚焦的真实进程测试覆盖本包的跨服务关系。 |

## 持久事件

已绑定的 Codex 会话可以在已配置的 Codex 模型之间切换，无需创建新 thread。DSH 先记录模型选择，再应用该选择；下一次 `turn/start` 会传递所选模型和推理强度，恢复会话后亦然。进行中的 turn 保留其已捕获的模型。切换到标准循环仍需要新会话。

`codex/thread-bound` 在接收第一轮输入前保存 Codex thread id、runtime 版本与工作区。`codexThreadBinding` Host 投影保留首个绑定；同一 DSH 会话若被绑定到不同 thread 元数据，会记录冲突；客户端视图只暴露是否存在绑定。resume 遇到缺失或冲突绑定必须拒绝，不能静默创建替代 thread。

`codex/turn-bound`、`codex/item/*`、`codex/usage` 与 `codex/error` 为 replay 和诊断保存 app-server 事实。它们不会成为模型历史；下一次请求恢复 Codex thread，而不是从 DSH 日志重新生成 prompt。

Codex 可以在同一 turn 中发布多个 `agentMessage` item。driver 分别将每个 item 的流式文本与完成文本对齐，然后提交该 turn 的 assistant 内容；不能把后一个 item 与前面所有 item 拼接后的增量比较。

app-server 进程由多个 agent thread 共享。进程故障会拒绝附着在该代进程上的工作；下一次连接会启动并初始化新一代进程，然后每个持久会话恢复自己的 thread id。

## 模型体验

### Codex thread 延续

#### 模型看到什么

Codex 看到原生持久 thread 历史与原生工具。DSH 只通过 `turn/start` 发送新接纳的用户输入，不重放其投影 transcript。

#### Token 影响

每一轮产生 Codex 原生的输入与输出 token 成本。诊断投影事件不增加模型 token。

#### KV Cache 影响

provider 通过 `codex/thread-bound` 保留 Codex thread id，并保留工作区与原生追加历史。provider prompt cache 的可用性与淘汰仍由 Codex/上游负责；改变模型、指令、工具或工作区可能让变化点之后的复用失效。

## 已知限制与延期工作

- **Codex runtime 兼容性固定版本**——升级所打包的 runtime 前，必须重新生成 app-server 契约证据并运行集成测试。
- **图片需要 Host 可见存储**——文本和 DSH 图片 block 会映射为原生输入；没有 app-server 可见本地路径的图片、文件附件与未知 block 会在 `turn/start` 前失败。
- **交互请求采取保守策略**——command/file/permission 审批与 request-user-input 使用带持久审批审计的作用域 DSH 服务。MCP elicitation、dynamic tool、Host token refresh、attestation 与 secret question 仍然 fail-closed。
- **原生事件投影不是第二份模型历史**——command、文件变化、工具、推理与 compaction 仍由 Codex 权威持有。
- **Chat Completions 只暴露 function tool**——Responses tool namespace 会被展开；`web_search` 等 Responses 托管工具在 Chat Completions 中没有对应表示，因此会被省略。上游实现这些原生工具类型时请使用 `apiFormat: responses`。
- **gateway 当前只接受文本模型输入**——即使复制的 provider profile 声明图片支持，通过模型 gateway 的图片输入仍延期实现。
