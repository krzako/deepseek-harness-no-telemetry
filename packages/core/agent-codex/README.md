---
description: "The Codex app-server Agent provider for users selecting Codex as the complete DSH loop and maintainers mapping its durable thread and item events."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

English | [中文](README.zh.md)

## Summary

`dsh-agent-codex` drives a persistent Codex app-server thread as a DSH `Agent`. Codex owns model history, reasoning, native tools, shell and filesystem work; DSH owns publication, persistence, UI/audit projection, and a durable mapping to the Codex thread. The provider registers the `codex` driver under the existing `agent-loop` lifecycle factory, so ordinary and Codex-backed agents can coexist in one process.

The `codex.enabled` setting defaults to `false`. In Settings → Plugins → Plugin configuration, the Codex card saves this switch and an optional `label`. When enabled, a new session whose selected `provider/model` pair is also listed under `codex.providers` uses the Codex driver; when disabled, that pair uses the standard agent loop. A blank standard session can adopt Codex when its model is explicitly selected; after a turn starts, changing driver requires a new session. A persisted Codex thread binding resumes through Codex even if the switch is later disabled. Each configured Codex provider appears as a separate model-picker group named `<label>: <provider display name>`; without `label`, the agent key `codex` is used. Its model names carry the same agent prefix. The `codex` driver route remains available without a duplicate model-picker group.

## Use this package

Install the package's profile patch and create an agent using a configured `codex:<provider>` route. DSH launches this deployment's Codex driver with native sandboxing disabled and relies on the Docker container as the execution boundary.

```yaml
- name: '@deepseek-ai/dsh-agent-codex'
  config:
    cwd: /absolute/default/workspace
    approvalPolicy: never
```

| Field | Default | Meaning |
|---|---|---|
| `cwd` | Host working directory | app-server process cwd and fallback for sessions without a durable cwd |
| `approvalPolicy` | `never` | native Codex approval policy |
| `disposeGraceMs` | `3000` | process-tree shutdown grace |
| `turnTimeoutMs` | `0` | per-turn timeout in milliseconds; zero disables it |
| `env` | `{}` | deliberate environment overlay after DSH's shared credential scrub |
| `enabled` | `false` | automatically select Codex for matching new sessions |

Create the agent through the normal registry and select the driver with its provider route:

```ts
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: '/absolute/workspace' },
  agentOptions: { provider: 'codex:llm_proxy', model: 'llm_proxy/qwen3.8-27b' },
})
```

The plugin uses the deployment-owned Codex fork binary at `DSH_CODEX_BIN` (the DSH image sets `/opt/codex/bin/codex`) and the official `codex app-server --stdio` protocol. `DSH_CODEX_REVISION` is persisted with the protocol revision in each thread binding. It does not search `PATH`, resolve an npm Codex package, or parse terminal output.

Models for the full Codex agent live in their own `codex` settings section. The provider profile shape intentionally matches `llm-pi-ai`; it is duplicated rather than inherited, so changing one agent family does not silently change the other. `apiFormat` is optional and defaults to `chat-completions`.

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

The selected Codex model id is `llm_proxy/qwen3.8-27b`; the model picker exposes it under `Codex: llm_proxy` with route `codex:llm_proxy`. Codex always talks Responses to an authenticated loopback gateway. For the default format, the gateway adapts messages, function tools, tool results, streaming text, streamed function calls, usage, and errors to OpenAI-compatible Chat Completions. With `apiFormat: responses`, it proxies the native Responses request and SSE stream while replacing only the routed model id and upstream authentication.

Set `CODEX_LOG_REQUESTS=true` in the Docker `.env` to save each authenticated Codex-to-gateway exchange as four JSON files with one timestamp/UUID prefix: `_input_headers.json`, `_input_body.json`, `_output_headers.json`, and `_output_body.json`. Logging is off by default. The production bind mount is `../volumes/codex-requests`; the test instance uses `../volumes/codex-requests-test`. These are gateway requests and responses, not the transformed upstream Chat Completions payloads. The output body holds the raw response text and a `complete` flag for interrupted streams. Authentication headers are redacted, but prompts and tool content may contain secrets; protect the volume and disable logging when it is not needed.

The DSH Codex driver always starts threads with `danger-full-access`; its approval policy defaults to `never`. It does not invoke Codex's Linux `bubblewrap` sandbox. Docker still limits the container, but mounted files, environment credentials, and reachable network services remain accessible to the agent.

### Source map

| File | Role |
|---|---|
| [`src/provider.ts`](src/provider.ts) | Settings ownership, model catalog, driver registration, and runtime lifetime |
| [`src/model-gateway.ts`](src/model-gateway.ts) | Authenticated Responses gateway, Chat Completions adapter, and native Responses proxy |
| — | No runtime invariant companion is published; schema validation and focused real-process tests cover this package's cross-service relationships. |

## Durable events

A bound Codex session can switch between configured Codex models without starting a new thread. DSH records the selection before applying it; the next `turn/start` carries the selected model and reasoning effort, including after resume. An active turn keeps its captured model. Switching to the standard loop still requires a new session.

`codex/thread-bound` stores the Codex thread id, runtime version, and workspace before the first turn is admitted. The `codexThreadBinding` host projection retains the first binding and records a conflict if the same DSH session is rebound to different thread metadata; its client view exposes only whether a binding exists. Resume must reject a missing or conflicted binding rather than create a replacement thread.

`codex/turn-bound`, `codex/item/*`, `codex/usage`, and `codex/error` preserve app-server facts for replay and diagnostics. They do not become model history; the next request resumes the Codex thread instead of deriving a prompt from the DSH log.

Codex may publish more than one `agentMessage` item in a turn. The driver reconciles streamed text with each item's completed text separately, then commits the turn's assistant content; a later item must not be compared with the concatenated deltas of earlier items.

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
- **Chat Completions exposes function tools only** — Responses tool namespaces are flattened; Responses-hosted tools such as `web_search` have no Chat Completions representation and are omitted. Use `apiFormat: responses` when the upstream implements those native tool types.
- **The gateway currently accepts text model input** — image input through the model gateway is deferred even when a copied provider profile advertises image support.
