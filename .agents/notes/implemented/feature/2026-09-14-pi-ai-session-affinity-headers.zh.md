# Agent Note: 手声明 pi-ai 路由的会话亲和传输头

Status: implemented

[English](2026-09-14-pi-ai-session-affinity-headers.md) | 中文

## 问题

一个私有的 OpenAI 兼容网关需要在请求上携带稳定的每会话标识——copilot-proxy 用它来组织自己的会话记录——而正确的值本就由 harness 持有：agent loop 在 `GenerateOptions.sessionId` 上为每个模型请求打上持久的会话 id，`dsh-llm-pi-ai` 又把它转发给 pi-ai。只要模型的 compat 带 `sendSessionAffinityHeaders`，pi-ai 的 `openai-completions` 实现就会把这个 id 变成会话亲和传输头；但 DSH 的 compat 门把 `sendSessionAffinityHeaders` 和 `sessionAffinityFormat` 归为 `withhold`，任何配置面都无法启用它们。pi-ai 已经拿到的 id 被丢弃，请求到达网关时不带任何会话身份；网关自己的记录无法区分不同的 harness 会话。

`withhold` 的适用前提是“已安装的 pi-ai 目录已经替某个具名厂商设置好了该字段”——想去配置它就该改用那个厂商的目录路由。这两个字段都不满足：没有任何目录条目设置它们，pi-ai 的检测默认关闭它们，而私有网关的 URL 也推不出任何亲和语义。这个分类对“必须显式告知”的可配置 compat 面而言就是错的。

## 决策

这两个字段对 `openai-completions` 改为 `offer`，并像其他 compat 开关一样可按路由、按模型配置，宿主面见 [[2026-08-18-pi-ai-wire-compat-surface]]：

- `sendSessionAffinityHeaders`——携带会话 id 的请求是否随行亲和传输头。
- `sessionAffinityFormat`——头的拼法：`openrouter` 发送 `x-session-id`；`openai` 发送 `session_id` 加 `x-client-request-id` 和 `x-session-affinity`；`openai-nosession` 发送后者这对、不带 `session_id`。

`sessionAffinityFormat` 经 `Record` 键漂移门（`PiAiSessionAffinityFormat`）从 pi-ai 自己的 compat 类型派生，上游新增拼法会在编译期失败直到被命名。这两个字段对 `openai-responses`、`azure-openai-responses`、`openai-codex-responses` 和 `anthropic-messages` 保持 `withhold`：当前没有消费方经此路由使用这些协议，协议读不懂的开关应在写入处被拒绝而不是被静默跳过。

线上的优先级沿用 pi-ai 自身的行为：亲和头先构建，请求的 `headers` 最后合并，所以显式配置的 profile 头在同名冲突时胜出。不带会话 id 的请求不发送任何亲和头；`cacheRetention: none` 的 profile 会把 id 连同缓存一起丢弃——pi-ai 把该 id 当作 prompt-cache 状态——线级测试把这一点钉住，上游升级无法悄悄改变它。会话 id 本身不动：不在任何地方再造第二个 id，id 只作为传输元数据旅行，绝不进入消息或 token 记账。

## 备选方案

**通用头模板**（`headers: {x-session-id: "{sessionId}"}`）。占位符白名单、缺 id 语义、冲突规则——为一两个网关重造 pi-ai 已经实现的东西。只有当某个网关需要 pi-ai 拼法表达不了的头名时才重新考虑。

**`sessionHeader` provider 字段。**比模板窄，但仍然是把 pi-ai compat 已承载的能力重新教给适配器，而且拼不出 `openai` 三件套。没有消费方需要它。

**在 copilot-proxy 内部用自己生成的 id 组织会话。**网关会发明 harness 已有的身份；不同 harness 会话的记录会并进同一个代理会话。已否决，改为翻译入站的亲和头（代理为其 `deepseek-harness` 来源读取 `x-session-id`，body 元数据仍在时优先）。

**同时为 Responses 与 Anthropic 协议 offer。**等有消费方经此面使用这些协议再说；届时门开关只改两行。

## 后果

- 手声明的 completions 网关可以完全靠 `settings.yaml` 获得稳定的每会话亲和 id——`compat: {sendSessionAffinityHeaders: true, sessionAffinityFormat: openrouter}` 让 loop、compaction、标题生成对该会话的每个请求都发送 `x-session-id: <session id>`。
- `copilot-proxy` 在没有 body 元数据时按 `x-session-id` 传输头组织 DeepSeek Harness 会话；部署同时以静态 profile 头发送 `x-proxy-source: deepseek-harness`，避免亲和头被当成 OpenCode 的。
- 路由保持按 provider 选择性加入：未启用开关的路由发出的请求与之前完全一致，包括拒绝未知头的 OpenAI 兼容网关。
- 覆盖：`tests/session-affinity.spec.ts` 断言真实 HTTP 线——同一会话内稳定、跨会话区分、`openai` 拼法集合、无 id 不发头、`cacheRetention: none` 不发头、显式头优先、未加入的 provider 不受影响——`tests/catalog.spec.ts` 覆盖路由级与模型级应用及协议拒绝。
