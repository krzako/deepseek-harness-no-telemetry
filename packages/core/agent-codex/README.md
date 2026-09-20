---
description: "The Codex app-server Agent provider for users selecting Codex as the complete DSH loop and maintainers mapping its durable thread and item events."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

English | [中文](README.zh.md)

## Summary

`dsh-agent-codex` drives a persistent Codex app-server thread as a DSH `Agent`. Codex owns model history, reasoning, native tools, shell and filesystem work; DSH owns publication, persistence, UI/audit projection, and a durable mapping to the Codex thread. The provider registers the `codex` driver under the existing `agent-loop` lifecycle factory, so ordinary and Codex-backed agents can coexist in one process.

## Use this package

Install the package's profile patch and create an agent with `provider: codex`. The default configuration refuses approval elevation and keeps Codex in its native workspace-write sandbox.

```yaml
- name: '@deepseek-ai/dsh-agent-codex'
  config:
    cwd: /absolute/default/workspace
    approvalPolicy: never
    sandbox: workspace-write
```

| Field | Default | Meaning |
|---|---|---|
| `cwd` | Host working directory | app-server process cwd and fallback for sessions without a durable cwd |
| `approvalPolicy` | `never` | native Codex approval policy |
| `sandbox` | `workspace-write` | native Codex sandbox mode |
| `disposeGraceMs` | `3000` | process-tree shutdown grace |
| `turnTimeoutMs` | `0` | per-turn timeout in milliseconds; zero disables it |
| `env` | `{}` | deliberate environment overlay after DSH's shared credential scrub |

Create the agent through the normal registry and select the driver with its provider route:

```ts
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: '/absolute/workspace' },
  agentOptions: { provider: 'codex', model: 'gpt-codex' },
})
```

The plugin uses the deployment-owned Codex fork binary at `DSH_CODEX_BIN` (the DSH image sets `/opt/codex/bin/codex`) and the official `codex app-server --stdio` protocol. `DSH_CODEX_REVISION` is persisted with the protocol revision in each thread binding. It does not search `PATH`, resolve an npm Codex package, or parse terminal output.

## Durable events

`codex/thread-bound` stores the Codex thread id, runtime version, and workspace before the first turn is admitted. The `codexThreadBinding` host projection retains the first binding and records a conflict if the same DSH session is rebound to different thread metadata. Resume must reject a missing or conflicted binding rather than create a replacement thread.

`codex/turn-bound`, `codex/item/*`, `codex/usage`, and `codex/error` preserve app-server facts for replay and diagnostics. They do not become model history; the next request resumes the Codex thread instead of deriving a prompt from the DSH log.

The app-server process is shared across agent threads. A process failure rejects work attached to that exact generation; the next connection starts and initializes a new generation, then each persisted session resumes its own thread id.

## Model Experience

### Codex thread continuation

#### What the model sees

Codex sees its native persistent thread history and native tools. DSH sends only newly admitted user input through `turn/start` and does not replay its projected transcript.

#### Token effect

Each turn has Codex's native input and output token cost. Diagnostic projection events add no model tokens.

#### KV Cache effect

The provider preserves the Codex thread id through `codex/thread-bound`, the workspace, and native append-only history. Provider prompt-cache availability and eviction remain outside DSH; changing Codex model, instructions, tools, or workspace can invalidate reuse after the changed prefix.

## Known Limitations and Deferred Work

- **Codex runtime compatibility is version-pinned** — upgrading the packaged runtime requires regenerated app-server contract evidence and integration tests before release.
- **Images require host-visible storage** — text and DSH image blocks are mapped natively; an image without an app-server-visible local path, file attachments, and unknown blocks fail before `turn/start`.
- **Interactive requests are conservative** — command/file/permission approvals and request-user-input use the scoped DSH services with durable approval audit. MCP elicitation, dynamic tools, host token refresh, attestation, and secret questions remain fail-closed.
- **Native event projection is structural, not a second model history** — Codex remains authoritative for commands, file changes, tools, reasoning, and compaction.
