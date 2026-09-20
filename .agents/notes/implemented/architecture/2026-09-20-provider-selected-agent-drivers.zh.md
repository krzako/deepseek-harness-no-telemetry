# Agent Note: Provider-selected agent drivers share one lifecycle factory

Status: implemented

[English](2026-09-20-provider-selected-agent-drivers.md) | 中文

## Problem

公开 `Agent` 契约允许使用进程内 React/model/tool loop 之外的 driver，但 `AgentRegistry` 过去把 create 与 resume 委托给单一 `AgentFactory`，由 `AgentLoop` 实现。完整 Codex 集成需要 Codex 通过 app-server 拥有模型历史、工具、文件系统工作、审批与 compaction。把 Codex 当作 `LlmAdapter` 会运行两套 loop；注册第二个顶层 factory 则会复制 Session 持久化、setup、发布、rollback、所有权与 teardown。

外部 driver 还具有必须在发布前就绪的异步状态：新的 DSH Session 需要一个持久 Codex thread 绑定，恢复的 Session 必须校验并恢复恰好同一个 thread。这些准备不能等到观察者收到 `agent/created` 之后才执行。

## Decision

`AgentLoop` 仍是唯一注册的 `AgentFactory`，也是 create/resume 持久化、未发布 setup、registry 发布、rollback 与有序 teardown 的唯一 owner。`AgentRegistry.setDriverFactory(provider, factory)` 在该 lifecycle 之下增加进程级、按 provider 键控的执行 seam。准备期间，`AgentLoop` 根据所选 `AgentOptions.provider` 查询 registry；没有注册 route 时保持现有 `ReactLoopAgent` 行为。

`AgentDriverFactory` 围绕已经准备但尚未发布的 Session 同步构造 `AgentDriver`。driver 暴露公开 `agent`、异步 `start(source, signal)` barrier 与异步 `dispose()` 静止边界。共享 lifecycle 在保存最终未发布 suffix、进入任一 registry 之前等待 `start`。因此失败仍由同一事务 rollback，而 disposal 继续由 `AgentLoop` 记忆化并排序。

`@deepseek-ai/dsh-agent-codex` 只注册 `codex` driver。共享 supervisor 启动包内固定版本的官方 app-server；每个 Codex agent 在 `start` 中创建或恢复一个持久原生 thread。Session 的版本化 `codex/thread-bound` event 是持久身份权威；绑定冲突与 runtime 版本不匹配会拒绝 resume。Codex 原生 item 与 usage event 只是 DSH 审计/UI 投影，绝不会作为重建 Codex 模型历史的输入。

本决策补充现有的 [agent scope runtime design](2026-07-12-agent-scope-runtime-design.zh.md) 与 [agent lifecycle ownership contract](2026-06-18-agent-lifecycle-and-ownership-contracts.zh.md)。它们关于发布、所有权与 teardown 的决定继续有效；两者均未被取代。

## Verification

聚焦的 Agent Codex 测试验证：首条消息前创建持久 thread、精确 thread resume、绑定冲突拒绝、follow-up 串行化、原生 item 与 usage 投影、assistant settlement、拒绝未知 app-server request、进程代复用、退出后重启及进程 disposal。现有 AgentLoop 测试继续覆盖默认 driver 路径；typecheck 覆盖共享接口与两个实现。

## Alternatives considered

**把 Codex 注册为另一个顶层 `AgentFactory`。** 这种方式让 provider 选择很直接，却会复制最容易出错的 lifecycle 事务。持久化修复、owner-fiber 取消、setup commit、registry 通知顺序与 teardown 会出现两个可能漂移的实现。

**把 Codex 实现成 `LlmAdapter`。** 这保留现有 loop，却把 Codex 当作一次模型调用。DSH 会在 Codex 原生 loop 外再执行自己的工具与历史 loop，破坏原生 shell/文件系统/工具行为，并让 compaction 与 cache 所有权含混。

**为整个 profile 替换 `AgentLoop`。** profile 级选择无需 routing seam，但普通 agent 与 Codex agent 不能共存，而且一个可选产品集成会拥有无关 agent。

**每轮启动新的 app-server 与 ephemeral thread。** 现有 subagent provider 有意为一次性委派采用这一形状。完整 Agent 会因此失去原生历史、thread cache 连续性、可恢复性与并发复用。

## Consequences

lifecycle 事务保持单一实现，而执行可随 provider 变化。替代 driver 继承相同的 Session 身份、setup、持久化、owner scope、registry event 与 teardown 顺序，无需依赖默认 LLM/tool loop。driver 可以异步准备外部状态而不暴露半初始化 Agent。

新 seam 是受信任的 Host 代码：driver factory 必须为传入身份与 Session 返回对应 Agent，使 `start` 可安全 rollback，并使 `dispose` 达到完全静止。provider key 在进程内唯一。Codex runtime 升级仍是显式兼容工作，因为持久绑定记录所打包 runtime 的精确版本。
