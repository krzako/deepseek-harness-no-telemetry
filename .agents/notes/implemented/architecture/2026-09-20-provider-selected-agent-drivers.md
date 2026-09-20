# Agent Note: Provider-selected agent drivers share one lifecycle factory

Status: implemented

English | [中文](2026-09-20-provider-selected-agent-drivers.zh.md)

## Problem

The public `Agent` contract permits a driver other than the in-process React/model/tool loop, but `AgentRegistry` previously delegated creation and resume to one `AgentFactory`, implemented by `AgentLoop`. A full Codex integration needs Codex to own model history, tools, filesystem work, approvals, and compaction through app-server. Treating Codex as an `LlmAdapter` would run two loops, while registering a second top-level factory would duplicate session persistence, setup, publication, rollback, ownership, and teardown.

The external driver also has asynchronous state that must exist before publication: a fresh DSH Session needs one persistent Codex thread binding, and a resumed Session must validate and resume exactly that thread. That preparation cannot occur after observers receive `agent/created`.

## Decision

`AgentLoop` remains the sole registered `AgentFactory` and the sole owner of create/resume persistence, unpublished setup, registry publication, rollback, and ordered teardown. `AgentRegistry.setDriverFactory(provider, factory)` adds a process-scoped, provider-keyed execution seam beneath that lifecycle. During preparation, `AgentLoop` asks the registry for the selected `AgentOptions.provider`; no registered route preserves the existing `ReactLoopAgent` behavior.

An `AgentDriverFactory` synchronously constructs an `AgentDriver` around the already prepared, unpublished Session. The driver exposes its public `agent`, an asynchronous `start(source, signal)` barrier, and an asynchronous `dispose()` quiescence boundary. The shared lifecycle awaits `start` before storing the final unpublished suffix and before entering either registry. Failure therefore rolls the same transaction back, while disposal remains memoized and ordered by `AgentLoop`.

`@deepseek-ai/dsh-agent-codex` registers only the `codex` driver. Its shared supervisor starts the package-pinned official app-server, and each Codex agent creates or resumes one persistent native thread during `start`. The Session's versioned `codex/thread-bound` event is the durable identity authority; conflicting bindings and runtime-version mismatches reject resume. Native Codex item and usage events are a DSH audit/UI projection, never input used to reconstruct Codex model history.

This supplements the existing [agent scope runtime design](2026-07-12-agent-scope-runtime-design.md) and [agent lifecycle ownership contract](2026-06-18-agent-lifecycle-and-ownership-contracts.md). Their publication, ownership, and teardown decisions remain authoritative; neither is superseded.

## Verification

Focused Agent Codex tests prove persistent thread creation before the first message, exact thread resume, conflicting-binding rejection, serialized follow-ups, native item and usage projection, assistant settlement, app-server request refusal, process-generation reuse, restart after exit, and process disposal. The existing AgentLoop suite continues to exercise the default driver path; typechecking covers the shared interface and both implementations.

## Alternatives considered

**Register Codex as another top-level `AgentFactory`.** This makes provider selection simple but copies the most failure-sensitive lifecycle transaction. Persistence repair, owner-fiber cancellation, setup commits, registry announcement ordering, and teardown would acquire two implementations that can drift.

**Implement Codex as an `LlmAdapter`.** This preserves the existing loop but asks DSH to interpret Codex as one model call. DSH would then execute its own tools and history loop around Codex's native loop, defeating native shell/filesystem/tool behavior and making compaction and cache ownership ambiguous.

**Replace `AgentLoop` for the whole profile.** A profile-wide choice avoids a routing seam but prevents ordinary and Codex-backed agents from coexisting and makes one optional product integration own unrelated agents.

**Start a new app-server and ephemeral thread per turn.** The existing subagent provider intentionally uses that shape for one-shot delegation. A full Agent would lose native history, thread cache continuity, resumability, and concurrent multiplexing.

## Consequences

The lifecycle transaction has one implementation while execution can vary by provider. Alternative drivers inherit the same Session identity, setup, persistence, owner scope, registry events, and teardown ordering without depending on the default LLM/tool loop. A driver may prepare external state asynchronously without exposing a partially initialized Agent.

The new seam is trusted host code: driver factories must return an Agent for the supplied identity and Session, make `start` rollback-safe, and make `dispose` fully quiescent. Provider keys are process-unique. Codex runtime upgrades remain explicit compatibility work because the persistent binding records the exact packaged runtime version.
