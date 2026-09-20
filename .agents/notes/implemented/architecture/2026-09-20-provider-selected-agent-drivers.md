# Agent Note: Provider-selected agent drivers share one lifecycle factory

Status: implemented

English | [中文](2026-09-20-provider-selected-agent-drivers.zh.md)

## Problem

The public `Agent` contract permits a driver other than the in-process React/model/tool loop, but `AgentRegistry` previously delegated creation and resume to one `AgentFactory`, implemented by `AgentLoop`. A full Codex integration needs Codex to own model history, tools, filesystem work, approvals, and compaction through app-server. Treating Codex as an `LlmAdapter` would run two loops, while registering a second top-level factory would duplicate session persistence, setup, publication, rollback, ownership, and teardown.

The external driver also has asynchronous state that must exist before publication: a fresh DSH Session needs one persistent Codex thread binding, and a resumed Session must validate and resume exactly that thread. That preparation cannot occur after observers receive `agent/created`.

## Decision

`AgentLoop` remains the sole registered `AgentFactory` and the sole owner of create/resume persistence, unpublished setup, registry publication, rollback, and ordered teardown. `AgentRegistry.setDriverFactory(provider, factory)` adds a process-scoped, provider-keyed execution seam beneath that lifecycle. During preparation, `AgentLoop` asks the registry for the selected `AgentOptions.provider`; no registered route preserves the existing `ReactLoopAgent` behavior.

An optional, effect-scoped `setDriverSelector()` policy runs after exact provider routing and before the ordinary loop is constructed. The Codex provider uses it when `codex.enabled` is true and the selected provider/model pair has a matching `codex.providers` route. The setting defaults off. A Session with an ordinary committed turn keeps the standard loop after the setting changes; a Session with a durable Codex thread binding resumes through Codex even when the switch is off. Explicit `provider: codex` remains an exact route.

An `AgentDriverFactory` synchronously constructs an `AgentDriver` around the already prepared, unpublished Session. The driver exposes its public `agent`, an asynchronous `start(source, signal)` barrier, and an asynchronous `dispose()` quiescence boundary. The shared lifecycle awaits `start` before storing the final unpublished suffix and before entering either registry. Failure therefore rolls the same transaction back, while disposal remains memoized and ordered by `AgentLoop`.

`@deepseek-ai/dsh-agent-codex` registers the exact `codex` driver and the optional automatic selector. Its shared supervisor starts the deployment-owned, revision-pinned Codex fork, and each Codex agent creates or resumes one persistent native thread during `start`. The Session's versioned `codex/thread-bound` event is the durable identity authority; conflicting bindings and runtime-version mismatches reject resume. Native Codex item and usage events are a DSH audit/UI projection, never input used to reconstruct Codex model history.

The full driver owns a separate `codex.providers` settings section whose profile shape mirrors `llm-pi-ai` without inheriting its values. The optional `codex.label` controls the Settings card title and the model-picker display prefix; without it, the settings key `codex` is used. Each configured profile registers an exact `codex:<provider>` driver route and a model-picker group named `<label>: <provider display name>`; its model names also carry `<label>:` and the group advertises only that profile's encoded models. Explicit selection of the group uses Codex independently of the automatic switch. The legacy `codex` route remains routable without advertising duplicate models. Codex is pinned through process-local configuration to an authenticated loopback Responses endpoint. The gateway routes the encoded provider/model selection, adapts the default `chat-completions` format through the shared pi-ai transport, and directly proxies `apiFormat: responses`. The format switch is provider data, so later wire adapters can join the routing boundary without changing the app-server lifecycle.

This supplements the existing [agent scope runtime design](2026-07-12-agent-scope-runtime-design.md) and [agent lifecycle ownership contract](2026-06-18-agent-lifecycle-and-ownership-contracts.md). Their publication, ownership, and teardown decisions remain authoritative; neither is superseded.

## Verification

Focused Agent Codex tests prove persistent thread creation before the first message, exact thread resume, conflicting-binding rejection, serialized follow-ups, native item and usage projection, assistant settlement, app-server request refusal, process-generation reuse, restart after exit, and process disposal. Gateway tests cover Chat Completions text and function-call streaming, function definitions and results, authentication and errors, and native Responses proxying. A real app-server integration test completes two continued turns through each format. The existing AgentLoop suite continues to exercise the default driver path; typechecking covers the shared interface and both implementations.

The settings-selector test covers switch-on routing for a matching new Session, switch-off fallback, nonmatching models, existing standard turns, bound Codex resume, and exact per-provider catalog routes. The seed-settings test pins the duplicated provider profiles and models against the `llm-pi-ai` seed. Browser card tests cover staged persistence and the visible switch.

## Alternatives considered

**Register Codex as another top-level `AgentFactory`.** This makes provider selection simple but copies the most failure-sensitive lifecycle transaction. Persistence repair, owner-fiber cancellation, setup commits, registry announcement ordering, and teardown would acquire two implementations that can drift.

**Implement Codex as an `LlmAdapter`.** This preserves the existing loop but asks DSH to interpret Codex as one model call. DSH would then execute its own tools and history loop around Codex's native loop, defeating native shell/filesystem/tool behavior and making compaction and cache ownership ambiguous.

**Replace `AgentLoop` for the whole profile.** A profile-wide choice avoids a routing seam but prevents ordinary and Codex-backed agents from coexisting and makes one optional product integration own unrelated agents.

**Rewrite the default model selection when toggling Codex.** This would need to retain and restore a prior provider/model choice across two settings namespaces. A driver selector leaves the model choice intact and scopes the switch to execution of matching new Sessions.

**Advertise every Codex model in one `codex` group.** A single group hides which upstream provider handles the selected model and makes the Codex and ordinary routes hard to compare. Exact per-profile routes give each upstream an identifiable group while preserving the legacy route for existing selections.

**Start a new app-server and ephemeral thread per turn.** The existing subagent provider intentionally uses that shape for one-shot delegation. A full Agent would lose native history, thread cache continuity, resumability, and concurrent multiplexing.

## Consequences

A bound Codex thread can change between configured Codex models. The selection is committed in the DSH Session, then the Codex driver sends the selected model on its next `turn/start`; active turns retain their captured model. The thread binding and native history remain unchanged.

The Docker container is this deployment's execution boundary. The DSH Codex driver always sends `danger-full-access` and defaults to `approvalPolicy: never`; it does not offer an inner-sandbox selector or require Docker namespace/mount exceptions for `bubblewrap`. A running driver keeps the thread options it was created with.

The deployment-only `CODEX_LOG_REQUESTS` switch defaults off. When enabled, the authenticated loopback gateway writes four correlated JSON files for each exchange: redacted input headers, input body, output headers, and raw output body with a stream-completion marker. The files use a dedicated Docker bind mount, separate between production and test instances. Prompt and tool content remains sensitive. Logging at this point covers both upstream formats without changing the model transport or the durable Session log.

The lifecycle transaction has one implementation while execution can vary by provider. Alternative drivers inherit the same Session identity, setup, persistence, owner scope, registry events, and teardown ordering without depending on the default LLM/tool loop. A driver may prepare external state asynchronously without exposing a partially initialized Agent.

The Codex switch affects new matching Sessions without rewriting `agent-default-model`. The default model records `agent: standard | codex` separately from the upstream provider, so identically named providers do not collide. A blank standard Session may be rebound to an explicit Codex route before its first turn; committed standard turns and bound Codex threads cannot silently switch drivers. Model routes absent from `codex.providers` continue through the standard loop. Seed profiles are duplicated deliberately rather than inherited, so later user edits to one section do not propagate to the other; seed parity is checked, but runtime parity remains the user's configuration choice.

The new seam is trusted host code: driver factories must return an Agent for the supplied identity and Session, make `start` rollback-safe, and make `dispose` fully quiescent. Provider keys are process-unique. Codex runtime upgrades remain explicit compatibility work because the persistent binding records the exact packaged runtime version.

The Chat Completions adapter can expose only function tools. It flattens Responses namespaces and omits hosted Responses-only tools that Chat Completions cannot represent; native Responses preserves those request and event types unchanged. Model-gateway image input remains deferred and the agent catalog advertises text until that conversion exists.
