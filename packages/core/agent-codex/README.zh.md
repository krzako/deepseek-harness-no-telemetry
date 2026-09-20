---
description: "面向选择 Codex 作为完整 DSH 循环的用户，以及维护其持久 thread 与事件映射的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

`dsh-agent-codex` 把持久 Codex app-server thread 作为 DSH `Agent` 驱动。Codex 拥有模型历史、推理、原生工具、shell 与文件系统工作；DSH 拥有发布、持久化、UI/审计投影，以及到 Codex thread 的持久映射。provider 在现有 `agent-loop` 生命周期工厂下注册 `codex` driver，因此普通 agent 与 Codex agent 可以共存于同一进程。

## 使用本包

安装本包的 profile patch，并用 `provider: codex` 创建 agent。默认配置拒绝提升审批，并让 Codex 使用其原生 workspace-write sandbox。

```yaml
- name: '@deepseek-ai/dsh-agent-codex'
  config:
    cwd: /absolute/default/workspace
    approvalPolicy: never
    sandbox: workspace-write
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cwd` | Host 工作目录 | app-server 进程 cwd，以及会话没有持久 cwd 时的后备目录 |
| `approvalPolicy` | `never` | Codex 原生审批策略 |
| `sandbox` | `workspace-write` | Codex 原生 sandbox 模式 |
| `disposeGraceMs` | `3000` | 进程树关闭宽限时间 |
| `turnTimeoutMs` | `0` | 每轮超时毫秒数；零表示禁用 |
| `env` | `{}` | DSH 共享凭据清理之后有意添加的环境变量层 |

通过普通 registry 创建 agent，并用 provider route 选择 driver：

```ts
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: '/absolute/workspace' },
  agentOptions: { provider: 'codex', model: 'gpt-codex' },
})
```

插件使用部署自有的 Codex fork 二进制（`DSH_CODEX_BIN`；DSH 镜像中为 `/opt/codex/bin/codex`）与官方 `codex app-server --stdio` 协议。`DSH_CODEX_REVISION` 会与协议版本一起持久化到 thread binding；它不搜索 `PATH`，不解析 npm Codex 包，也不解析终端文本。

## 持久事件

`codex/thread-bound` 在接收第一轮输入前保存 Codex thread id、runtime 版本与工作区。`codexThreadBinding` Host 投影保留首个绑定；同一 DSH 会话若被绑定到不同 thread 元数据，会记录冲突。resume 遇到缺失或冲突绑定必须拒绝，不能静默创建替代 thread。

`codex/turn-bound`、`codex/item/*`、`codex/usage` 与 `codex/error` 为 replay 和诊断保存 app-server 事实。它们不会成为模型历史；下一次请求恢复 Codex thread，而不是从 DSH 日志重新生成 prompt。

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
