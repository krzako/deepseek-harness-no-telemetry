# Agent Note: Provider-selected agent drivers share one lifecycle factory

Status: implemented

[English](2026-09-20-provider-selected-agent-drivers.md) | 中文

## Problem

公开 `Agent` 契约允许使用进程内 React/model/tool loop 之外的 driver，但 `AgentRegistry` 过去把 create 与 resume 委托给单一 `AgentFactory`，由 `AgentLoop` 实现。完整 Codex 集成需要 Codex 通过 app-server 拥有模型历史、工具、文件系统工作、审批与 compaction。把 Codex 当作 `LlmAdapter` 会运行两套 loop；注册第二个顶层 factory 则会复制 Session 持久化、setup、发布、rollback、所有权与 teardown。

外部 driver 还具有必须在发布前就绪的异步状态：新的 DSH Session 需要一个持久 Codex thread 绑定，恢复的 Session 必须校验并恢复恰好同一个 thread。这些准备不能等到观察者收到 `agent/created` 之后才执行。

## Decision

`AgentLoop` 仍是唯一注册的 `AgentFactory`，也是 create/resume 持久化、未发布 setup、registry 发布、rollback 与有序 teardown 的唯一 owner。`AgentRegistry.setDriverFactory(provider, factory)` 在该 lifecycle 之下增加进程级、按 provider 键控的执行 seam。准备期间，`AgentLoop` 根据所选 `AgentOptions.provider` 查询 registry；没有注册 route 时保持现有 `ReactLoopAgent` 行为。

可选且随 effect 生命周期注册的 `setDriverSelector()` 策略在精确 provider 路由之后、构造普通循环之前运行。`codex.enabled` 为 true 且所选 provider/model 在 `codex.providers` 中有匹配路由时，Codex provider 使用它；设置默认关闭。已有普通已提交轮次的 Session 在设置变化后继续使用标准循环；带持久 Codex thread binding 的 Session 即使开关关闭也通过 Codex 恢复。显式 `provider: codex` 仍是精确路由。

`AgentDriverFactory` 围绕已经准备但尚未发布的 Session 同步构造 `AgentDriver`。driver 暴露公开 `agent`、异步 `start(source, signal)` barrier 与异步 `dispose()` 静止边界。共享 lifecycle 在保存最终未发布 suffix、进入任一 registry 之前等待 `start`。因此失败仍由同一事务 rollback，而 disposal 继续由 `AgentLoop` 记忆化并排序。

`@deepseek-ai/dsh-agent-codex` 注册精确的 `codex` driver 和可选的自动 selector。共享 supervisor 启动部署自有且固定 revision 的 Codex fork；每个 Codex agent 在 `start` 中创建或恢复一个持久原生 thread。Session 的版本化 `codex/thread-bound` event 是持久身份权威；绑定冲突与 runtime 版本不匹配会拒绝 resume。Codex 原生 item 与 usage event 只是 DSH 审计/UI 投影，绝不会作为重建 Codex 模型历史的输入。

完整 driver 拥有独立的 `codex.providers` settings section；其 profile 形状与 `llm-pi-ai` 相同，但不继承后者的值。可选的 `codex.label` 控制 Settings 卡片标题和模型选择器的显示前缀；未设置时使用 settings 键名 `codex`。每个已配置 profile 都注册精确的 `codex:<provider>` driver 路由，以及名为 `<label>: <provider 显示名>` 的模型选择组；模型名称也带有 `<label>:` 前缀，该组只列出自身 profile 的编码模型。显式选择该组时不受自动切换开关影响。旧 `codex` 路由仍可使用，但不再重复展示模型。进程本地配置把 Codex 固定到经过认证的 loopback Responses endpoint。gateway 路由编码后的 provider/model 选择，通过共享 pi-ai transport 适配默认 `chat-completions` 格式，并直接代理 `apiFormat: responses`。格式开关属于 provider 数据，因此未来可以在不改变 app-server lifecycle 的情况下向该路由边界加入其他 wire adapter。

本决策补充现有的 [agent scope runtime design](2026-07-12-agent-scope-runtime-design.zh.md) 与 [agent lifecycle ownership contract](2026-06-18-agent-lifecycle-and-ownership-contracts.zh.md)。它们关于发布、所有权与 teardown 的决定继续有效；两者均未被取代。

## Verification

聚焦的 Agent Codex 测试验证：首条消息前创建持久 thread、精确 thread resume、绑定冲突拒绝、follow-up 串行化、原生 item 与 usage 投影、assistant settlement、拒绝未知 app-server request、进程代复用、退出后重启及进程 disposal。gateway 测试覆盖 Chat Completions 文本与 function-call streaming、function 定义与结果、认证与错误，以及原生 Responses 代理。真实 app-server 集成测试通过两种格式分别完成两个连续 turn。现有 AgentLoop 测试继续覆盖默认 driver 路径；typecheck 覆盖共享接口与两个实现。

设置 selector 测试覆盖匹配新 Session 的开关路由、关闭时的回退、不匹配模型、已有标准轮次、已绑定 Codex 的恢复，以及按 provider 分组的精确目录路由。seed-settings 测试确保复制的 provider profile 与模型和 `llm-pi-ai` seed 保持一致。浏览器卡片测试覆盖暂存后的持久化和可见开关。

## Alternatives considered

**把 Codex 注册为另一个顶层 `AgentFactory`。** 这种方式让 provider 选择很直接，却会复制最容易出错的 lifecycle 事务。持久化修复、owner-fiber 取消、setup commit、registry 通知顺序与 teardown 会出现两个可能漂移的实现。

**把 Codex 实现成 `LlmAdapter`。** 这保留现有 loop，却把 Codex 当作一次模型调用。DSH 会在 Codex 原生 loop 外再执行自己的工具与历史 loop，破坏原生 shell/文件系统/工具行为，并让 compaction 与 cache 所有权含混。

**为整个 profile 替换 `AgentLoop`。** profile 级选择无需 routing seam，但普通 agent 与 Codex agent 不能共存，而且一个可选产品集成会拥有无关 agent。

**切换 Codex 时重写默认模型选择。** 这需要跨两个 settings 命名空间保存并恢复先前的 provider/model 选择。driver selector 保留模型选择不变，并将开关限定于匹配的新 Session 的执行方式。

**把所有 Codex 模型放在单个 `codex` 组中。** 单个组隐藏了处理所选模型的上游 provider，也使 Codex 路由与普通路由难以比较。按 profile 设置精确路由让每个上游拥有可辨认的组，同时保留旧路由供已有选择使用。

**每轮启动新的 app-server 与 ephemeral thread。** 现有 subagent provider 有意为一次性委派采用这一形状。完整 Agent 会因此失去原生历史、thread cache 连续性、可恢复性与并发复用。

## Consequences

已绑定的 Codex thread 可以在已配置的 Codex 模型之间切换。选择先提交到 DSH Session，随后 Codex driver 在下一次 `turn/start` 传递所选模型；进行中的 turn 保留其已捕获的模型。thread binding 和原生历史保持不变。

Docker 容器是本部署的执行边界。DSH Codex driver 始终传递 `danger-full-access`，审批策略默认为 `never`；不提供内层沙箱选择，也不需要为 `bubblewrap` 放宽 Docker 的 namespace/mount 限制。运行中的 driver 保留创建时的 thread 选项。

仅供部署使用的 `CODEX_LOG_REQUESTS` 开关默认关闭。启用后，经过认证的 loopback gateway 为每次交互写入四个关联的 JSON 文件：遮蔽敏感信息的输入 header、输入 body、输出 header，以及带有流完成标记的原始输出 body。这些文件保存在生产与测试实例各自独立的 Docker bind mount 中。Prompt 与 tool 内容仍属于敏感信息。在此处记录可覆盖两种上游格式，且不改变模型传输或持久 Session log。

lifecycle 事务保持单一实现，而执行可随 provider 变化。替代 driver 继承相同的 Session 身份、setup、持久化、owner scope、registry event 与 teardown 顺序，无需依赖默认 LLM/tool loop。driver 可以异步准备外部状态而不暴露半初始化 Agent。

Codex 开关影响匹配的新 Session，而不重写 `agent-default-model`。默认模型把 `agent: standard | codex` 与上游 provider 分开记录，因此同名 provider 不会冲突。空白标准 Session 可在首轮之前绑定到显式 Codex 路由；已提交的标准轮次和已绑定的 Codex thread 不能静默切换 driver。`codex.providers` 中不存在的模型路由继续使用标准循环。seed profile 是有意复制而非继承的，所以用户随后对一个 section 的修改不会传播到另一个；测试确保 seed 一致，而运行时是否一致由用户配置决定。

新 seam 是受信任的 Host 代码：driver factory 必须为传入身份与 Session 返回对应 Agent，使 `start` 可安全 rollback，并使 `dispose` 达到完全静止。provider key 在进程内唯一。Codex runtime 升级仍是显式兼容工作，因为持久绑定记录所打包 runtime 的精确版本。

Chat Completions adapter 只能暴露 function tool。它会展开 Responses namespace，并省略 Chat Completions 无法表示的 Responses-only 托管工具；原生 Responses 会原样保留这些 request 与 event 类型。模型 gateway 的图片输入仍延期实现，在转换存在之前 agent catalog 只声明文本能力。
