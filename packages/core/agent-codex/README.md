---
description: "The Codex app-server Agent provider for users selecting Codex as the complete DSH loop and maintainers mapping its durable thread and item events."
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-codex

## Summary

`dsh-agent-codex` drives a persistent Codex app-server thread as a DSH `Agent`. Codex owns model history, reasoning, prompts, and compaction; DSH executes model requests and the tools selected by Codex, persists their audit, and maintains the durable thread mapping. The provider registers the `codex` driver under the existing `agent-loop` lifecycle factory, so ordinary and Codex-backed agents can coexist in one process.

The `codex.enabled` setting defaults to `false`. In Settings → Plugins → Plugin configuration, the Codex card saves this switch and an optional `label`. When enabled, a new session whose selected `provider/model` pair is also listed under `codex.providers` uses the Codex driver; when disabled, that pair uses the standard agent loop. A blank standard session can adopt Codex when its model is explicitly selected; after a turn starts, changing driver requires a new session. A persisted Codex thread binding resumes through Codex even if the switch is later disabled. Each configured Codex provider appears as a separate model-picker group named `<label>: <provider display name>`; without `label`, the agent key `codex` is used. Its model names carry the same agent prefix. The `codex` driver route remains available without a duplicate model-picker group.

## Table of Contents

- [Use this package](#use-this-package)
- [Durable events](#durable-events)
- [Audit artifact transfer](#audit-artifact-transfer)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

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
| `runtimeRevision` | `DSH_CODEX_REVISION` | fork revision passed to the app-server and used to assess private checkpoint compatibility |
| `approvalPolicy` | `never` | native Codex approval policy |
| `disposeGraceMs` | `3000` | process-tree shutdown grace |
| `turnTimeoutMs` | `0` | per-turn timeout in milliseconds; zero disables it |
| `env` | `{}` | deliberate environment overlay after DSH's shared credential scrub |
| `enabled` | `false` | automatically select Codex for matching new sessions |

Create the agent through the normal registry and select the driver with its provider route:

```ts ignore-check
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: '/absolute/workspace' },
  agentOptions: { provider: 'codex:llm_proxy', model: 'llm_proxy/qwen3.8-27b' },
})
```

The plugin uses the deployment-owned Codex fork binary at `DSH_CODEX_BIN` (the DSH image sets `/opt/codex/bin/codex`) and the official `codex app-server --stdio` protocol. `DSH_CODEX_REVISION` is persisted with the protocol revision in each thread binding. It does not search `PATH`, resolve an npm Codex package, or parse terminal output.

Models for the full Codex agent live in their own `codex` settings section. The provider profile shape intentionally matches `llm-pi-ai`; it is duplicated rather than inherited, so changing one agent family does not silently change the other. `apiFormat` is optional and defaults to `chat-completions`. Each configured route is declared to Settings → Models as `codex:<provider>`, with its profile addressed under `codex.providers`; committed settings edits refresh the model picker even when only a model list changes, and unloading the plugin withdraws its entries.

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

The gateway requires the shared process credential and Codex turn metadata on each model request. The provider resolves the metadata's thread and turn to one live DSH Session before contacting an upstream model; it rejects unknown or stale identities and unsupported request purposes. Each admitted request receives a distinct DSH attempt id. Before dispatch, the gateway flushes the original Codex request and the actual upstream HTTP request to the owning Session as `codex/model-audit` events. It flushes upstream response headers and raw stream chunks before passing them downstream; the translated Chat Completions result and usage are also flushed before the final Responses event. A failed durable flush stops the gateway. This audit requires session persistence and is independent of `CODEX_LOG_REQUESTS`; attempt retry idempotency remains separate work. Optional diagnostic input headers also carry Session, turn, purpose, and attempt correlation.

Codex's ordinary inference, automatic local compaction, and retry requests use the same authenticated gateway. A separate DSH attempt id records each retry. Native Responses also passes a remote-compaction request containing `compaction_trigger` unchanged and audits its result. The configured custom `dsh` provider currently defaults to local compaction, so enabling Codex remote compaction for eligible native Responses models remains a separate capability change.

Codex owns model retries. Its DSH provider disables the inner HTTP retry and sends a fresh `x-dsh-model-attempt-id` UUID on each request; the gateway rejects a UUID already recorded in the owning Session before issuing another upstream call. The gateway forwards cancellation and the profile's nonzero `timeoutMs` to upstream, waits for downstream backpressure, and audits an interrupted stream as incomplete. A timeout cannot prove that an upstream provider did no work or charged nothing.

Each admitted model attempt captures one `codex.providers` settings snapshot for its route, model, wire format, and endpoint. Its durable `upstream-request` audit entry records the resolved provider, model, and effective `apiFormat` beside the actual HTTP payload, without copying provider credentials. The gateway resolves the referenced credential immediately before the upstream call. A later settings edit or credential rotation applies to the next attempt (including a Codex retry), not an already-running stream. Omitting `apiFormat` selects Chat Completions; `responses` forwards the native format.

For Chat Completions, the gateway preserves text roles (`system`, `developer`, `user`, `assistant`), instructions, function definitions and strict schemas, tool choice, parallel calls and results, streamed tool-call arguments, usage, and distinct failed/incomplete terminal events. It translates ordered `input_text` and `input_image` parts into Chat text and `image_url` parts when the selected model declares image input. It rejects Responses-native reasoning history and hosted tools that Chat Completions cannot represent; nothing is silently discarded. The Codex process disables its native `web_search` tool so it does not advertise an untranslatable hosted tool before DSH-owned tools are installed.

Set `CODEX_LOG_REQUESTS=true` in the Docker `.env` to save each authenticated Codex-to-gateway exchange as four JSON files with one timestamp/UUID prefix: `_input_headers.json`, `_input_body.json`, `_output_headers.json`, and `_output_body.json`. Logging is off by default. The production bind mount is `../volumes/codex-requests`; the test instance uses `../volumes/codex-requests-test`. These are gateway requests and responses, not the transformed upstream Chat Completions payloads. The output body holds the raw response text and a `complete` flag for interrupted streams. Authentication headers are redacted, but prompts and tool content may contain secrets; protect the volume and disable logging when it is not needed.

The DSH Codex driver always starts threads with `danger-full-access`; its approval policy defaults to `never`. It does not invoke Codex's Linux `bubblewrap` sandbox. Docker still limits the container, but mounted files, environment credentials, and reachable network services remain accessible to the agent.

### Source map

| File | Role |
|---|---|
| [`src/provider.ts`](src/provider.ts) | Settings ownership, model catalog, driver registration, and runtime lifetime |
| [`src/model-gateway.ts`](src/model-gateway.ts) | Authenticated Responses gateway, Chat Completions adapter, and native Responses proxy |
| [`src/audit-contract.ts`](src/audit-contract.ts) | Versioned full-audit event and artifact-reference validator |
| [`src/audit-receiver.ts`](src/audit-receiver.ts) | Sequenced app-server audit admission and durable ACK |
| — | No runtime invariant companion is published; schema validation and focused real-process tests cover this package's cross-service relationships. |

## Durable events

New and imported Codex threads explicitly use `historyMode: legacy`. Required DSH checkpoints read the complete durable rollout; the fork rejects that read for paginated threads. Resume retains the persisted history mode. See the [history-mode decision](../../../.agents/notes/implemented/architecture/2026-10-11-codex-checkpoint-history-mode.md).

A bound Codex session can switch between configured Codex models without starting a new thread. DSH records the selection before applying it; the next `turn/start` carries the selected model and reasoning effort, including after resume. An active turn keeps its captured model. Switching to the standard loop still requires a new session.

`codex.enabled` controls automatic choice for a fresh matching session. A persisted `agent/driver-selected` with `driverId: codex` keeps Codex selected on resume even when the setting is off; `driverId: standard` prevents Codex from taking over a standard session with the same provider/model names. A missing configured model still fails explicitly.

For a Codex Session, the shared lifecycle constructs `CodexAgent` instead of `ReactLoopAgent`: Codex owns the turn and DSH does not also call its ordinary LLM adapter. A standard Session in the same composition constructs only `ReactLoopAgent` and does not start a Codex thread.

An explicit import route targeting `codex` is selectable even when automatic choice is disabled. The provider requires an attachment store and registers paired Codex transfer ports before its full-driver routes. Its source reads a completed Session and verified checkpoint, while its target checks the current model catalog and fork revision before returning an unpublished preparation. `createCodexImportedAgent()` uses that preparation to create a new DSH Session with import lineage and a fresh Codex thread initialized from the private V2 checkpoint. If thread startup fails, neither Agent nor Session is published. The importer does not replay historical model or tool actions. This same-driver operation requires a compatible private checkpoint; importing canonical context from another driver remains separate work.

`codex/thread-bound` stores the Codex thread id, runtime version, and workspace before the first turn is admitted. The `codexThreadBinding` host projection retains the first binding and records a conflict if the same DSH session is rebound to different thread metadata; its client view exposes only whether a binding exists. Resume must reject a missing or conflicted binding rather than create a replacement thread.

`CodexContextSnapshotV1` remains a recognized private checkpoint payload. The fork now emits `CodexContextSnapshotV2` after completed turns and installed compactions. Its `dsh-json-v1` hashes encode typed JSON values with UTF-8-sorted object keys and IEEE-754 number bits, so Rust and DSH validate the actual audit payload identically even when JSON field or number printing differs. Before DSH acknowledges a V2 checkpoint, it verifies the effective-history and rollout SHA-256 digests, the compaction chain against the durable rollout and prior installed facts, and the accepted turn configuration. The same checks run during Session-log export. Checkpoint blobs are verified and spooled to a private temporary file; their arrays are parsed item by item instead of buffering the complete artifact in RAM. `withVerifiedCodexCheckpointArtifactV2()` permits a callback to read validated fields and iterate arrays while that private spool exists, then removes it after success or failure. `streamVerifiedCodexCheckpointArtifactV2()` offers a projected iterator that starts verification on first consumption and removes the spool on EOF, projection failure, or iterator cancellation. Callers cannot retain lazy readers after either scope closes. There is no fixed global archive-size limit. On Codex provider startup, abandoned checkpoint files from dead process generations are removed; live generations and unrecognized temporary content are left untouched. `codexPrivateSnapshot()` wraps validated data in the shared namespaced driver slot; import/restoration remains separate work. The rollout is provenance, not instructions to replay model or tool effects.

`projectCodexResponseItem()` projects one V2 effective-history envelope into a canonical DSH item. It maps text, visible reasoning, and function calls directly. `codexPortableToolOutcomes()` joins durable Codex call bindings to DSH tool results; it rejects duplicate or mismatched results and leaves an unfinished call without an outcome. A function result becomes a canonical tool result only when that audited success or error is supplied; otherwise its original JSON remains opaque. `projectCodexEffectiveHistory()` validates the V2 checkpoint and projects every active item in order using those outcomes; `projectCodexEffectiveHistoryStream()` applies the same mapping to a verified iterator without retaining a projected item array. `projectCodexHistoricalItems()` independently projects rollout response items and installed replacement histories, with IDs disjoint from the active projection and output references for each compaction; `projectCodexHistoricalItemsStream()` yields those same items from verified rollout and compaction iterators and reports output references after each replacement. Non-history rollout events remain in the private snapshot. Neither helper alone assembles complete compaction ancestry. Unknown Responses variants, multimodal parts, and fields without a canonical equivalent remain namespaced opaque JSON, so a destination driver must report compatibility rather than silently discard them. These pure helpers do not yet register the Codex transfer port or publish an archive.

`resolveCodexInstalledCompactions()` groups each V2 installed compaction with its ordered, durable request/result or failure attempts and matching pending/installed history. `resolveCodexInstalledCompactionsStream()` accepts verified checkpoint compactions one at a time and yields the same groups without retaining the complete result array; the caller must consume it to EOF before publishing an export. Both resolve inline or session-owned artifact payloads through the caller, preserve retries, and reject missing settlements, cross-turn facts, conflicting replacement history, or out-of-order facts. The source port must still assemble canonical ancestry from these groups; resolving audit facts does not replay model or tool calls.

`projectCodexCompactionAncestry()` maps those validated groups into canonical compaction relations: the last successful request's input items, every attempt's full prompt and result or failure as namespaced provenance, and the installed output IDs from the rollout. `projectCodexCompactionAncestryStream()` yields the same items one installed group at a time and reports each relation after its items; incomplete consumption cannot establish a complete archive. Both derive local versus remote mode only from the audited implementation and reject missing or changed metadata. The active context and this ancestry still need composition by the Codex source transfer port.

`projectCodexPortableBundle()` combines the active and historical projections with audited ancestry, the persisted Codex driver/model route, and the intact V2 private checkpoint. It validates all canonical item references before returning the common `PortableAgentBundleV1`. A caller must read all inputs behind one completed-session barrier; this pure function does not obtain that barrier or register the source port.

`selectCodexPortableSourceFacts()` reads a supplied durable Session at a completed-turn boundary and selects only the final checkpoint whose ID and Codex turn binding match the last successful turn. It rejects an active or failed latest turn, duplicate or foreign thread binding, audit sequence or event-ID conflict, unresolved compaction, and a missing terminal checkpoint. Artifact bytes and the source model route are resolved separately before the bundle is published.

`codexPortablePayloadResolver()` reads inline JSON directly and artifact JSON only through a receipt committed in the same Session for the bound thread. It derives the content-addressed attachment reference from the digest, verifies media type, declared size, actual bytes and SHA-256, then parses JSON; no path from a payload is used. Its `codexPortableArtifactStream()` reader exposes the same receipt-owned bytes without full buffering and confirms the hash only after complete consumption. The JSON resolver and current portable bundle still materialize parsed payloads in memory; Codex context and private-checkpoint streaming remain separate work.

`codexPortableDriverState()` derives the source driver revision from the durable thread binding and the selected provider/model from the last inference upstream-request audit of the checkpoint's completed turn, falling back to a compaction-only request when necessary. It rejects missing, malformed, or post-checkpoint routes and retains import lineage. Current settings are not consulted, so later catalog changes do not rewrite the exported source identity.

`readCodexPortableBundle()` combines these checks for a completed, flushed or detached Codex Session. It verifies the session-owned checkpoint artifact, its audit chain, compaction attempts, source model route, and tool outcomes before returning one canonical bundle with the private V2 checkpoint. A concurrent Session append invalidates the read. `readCodexPortableStreamBundle()` instead projects active history, rollout and ancestry from a verified checkpoint spool into one-use item and reference iterators, with a second verified byte read for the private V2 checkpoint. It rejects a Session change before or during consumption; the ZIP consumer must finish all iterators and private bytes before publishing its manifest. `codexTransferSource()` adapts both reads to the shared source port after its caller restores or flushes the requested Session; a missing or mismatched ID fails. Its required `exportArchivedContext()` uses the supplied detached Session and artifact reader instead of the live resolver and local store; the same bundle projection and checkpoint checks apply. These reads perform no model or tool work.

Checkpoint and compaction-group audit validation hash artifact-backed pending/installed histories one array element at a time. Both passes verify the full receipt and JSON; memory remains proportional to the largest element. The streamed source verifies every attempt input history before retaining a fresh iterator, then projects the final attempt one element at a time. A failed or cancelled second read cannot publish its compaction relation. Artifact prompts, results and failure details use admitted opaque JSON streams. Admission validates the complete single JSON value, fatal UTF-8 decoding, finite numbers excluding negative zero, and the top-level prompt implementation before exposing bytes. It streams strings, keys and numbers without retaining complete scalars; every subsequent read rechecks the Session receipt. Failure wrappers have a receipt covering the message and full details. Inline payloads remain resident. Checkpoint audit validation compares artifact-backed context/config one top-level property at a time, independent of property order, and verifies its complete receipt even after finding a mismatch. It retains the checkpoint metadata and one configuration property; this is not a constant-memory guarantee for a single large property.

The registered Codex target reads authentication metadata through its current gateway configuration. Named references use credential `describe`, or the gateway environment only when that service is absent. Profiles without a key reference report provider-managed authentication. The inspector returns no key, creates no thread and sends no upstream request; missing routes reject and key presence does not establish validity.

`codexTransferTarget()` declares the current Codex model catalog and private V2 fork revision to the shared import assessment. The provider also passes that revision to the fork process as `DSH_CODEX_REVISION`, so emitted checkpoints identify the same runtime. The target validates a canonical V1 context, fresh Session ID, lineage, current target route and compatible private checkpoint, then returns frozen preparation only. `CodexAppServerClient.startThreadFromCheckpoint()` validates a private V2 payload and sends it to the fork's fresh `thread/start`, which refuses malformed context. `createCodexImportedAgent()` installs that payload during unpublished setup and starts the fresh thread before the shared factory publishes the destination Session. The provider registers both transfer ports before its driver routes; its source flushes a live Session or reads a detached one through session persistence.

`codex/turn-bound`, `codex/model-audit`, `codex/item/*`, `codex/usage`, and `codex/error` preserve app-server and model-transport facts for replay and diagnostics. They do not become model history; the next request resumes the Codex thread instead of deriving a prompt from the DSH log.

`CodexAuditEventV1Schema` defines the `codex/audit-v1` stream for model requests/chunks/results/failures, tool calls/approvals/results, compaction, context configuration, and checkpoints. Each fact carries a per-thread sequence and retry identity. Payloads are lossless inline JSON or SHA-256 artifact references without host paths; malformed versions, JSON, or digests are rejected. The app-server accepts `dshAudit/append` and `dshAudit/cursor` for the owning thread. DSH serializes concurrent appends and acknowledges a new fact only after `sessions.flush` succeeds; an identical replay returns its original ACK, while a gap, conflicting replay, wrong thread, or failed flush stops subsequent audit requests. Resume reconstructs the cursor from the Session log. A `compaction/pending` fact reserves one replacement history; until a matching `compaction/installed` or `compaction/aborted` confirms its ID and identical history, the receiver rejects every new fact, including the next turn's configuration. A restart restores this pending state from the Session log and cannot silently continue an unresolved compaction. New pending facts carry a SHA-256 anchor of the preceding durable rollout; legacy facts without the anchor remain readable but cannot be automatically aborted. The DSH client supplies `turn/start.dshAudit` with its Session ID and turn; the fork durably spools a `context/config` fact and waits for its ACK before it submits the turn. On reconnect it reconciles pending facts with DSH's cursor, including an ACK lost after a successful DSH commit. Checkpoint installation and artifact storage remain separate work; `codex/model-audit` remains the live gateway model audit.

Before each `turn/start`, the driver snapshots `ctx.tools.schemas(agent)`, sorts the visible functions by name, and records the complete `codex/tool-catalog` with a version and SHA-256 hash. The same catalog goes to the fork's per-turn `dynamicTools` override, including on the first turn after thread resume. A later DSH registration change therefore affects the next turn without replacing the Codex thread. For `item/tool/call`, DSH checks the owning thread and turn, the advertised name and schema, and current agent-scope visibility; `codex/tool-call-bound` records the stable mapping from Codex `callId` to DSH tool-call ID. DSH durably flushes `tool/call` before its policy/approval/guard/timeout tool runtime executes, then durably flushes `tool/result` before sending the committed result to Codex. An audit-storage failure aborts the turn instead of executing or returning an uncommitted result. Concurrent calls retain independent stable IDs. A duplicate in-flight call shares its execution; a completed call replays the persisted result; a call with no recorded result and no live execution fails as `outcome unknown` rather than repeating a possible side effect. Text and verified image attachments are projected into the app-server response. Tool policy refusals and cancellation become audited error results, and an interrupted turn drains its pending tools before closing the DSH step.

For DSH-owned threads, the fork composes a bounded delegated-tool instruction into its model request, including later turns and compaction. DSH does not supply or rewrite that instruction. It tells the model to use only functions supplied for the current request and not to assume native shell, patch, MCP, web, or delegation tools. The fork constructs a router solely from the supplied dynamic catalog, forces direct tool mode, and omits native, MCP, extension, and hosted model tools even when those features are configured. The thread's DSH client identity keeps this restriction on recovery if a per-turn catalog is absent. Physical source removal of dormant native implementations remains a separate step.

Codex may publish more than one `agentMessage` item in a turn. The driver reconciles streamed text with each item's completed text separately, then commits the turn's assistant content; a later item must not be compared with the concatenated deltas of earlier items.

The app-server process is shared across agent threads. A process failure rejects work attached to that exact generation; the next connection starts and initializes a new generation, then each persisted session resumes its own thread id.

## Audit artifact transfer

`dshAudit/artifact` accepts canonical base64 chunks of at most 256 KiB for an authenticated Codex thread. DSH fsyncs each staged chunk before acknowledging its offset, verifies the final SHA-256 and byte count, stores exact bytes in its content-addressed attachment store, and flushes a session-owned receipt before the final ACK. A reconnect can retry from the reported offset; a completed upload is idempotent. No path from the request becomes a storage path. Receipt validation checks version, owner, digest, byte count, media type and derived blob name both at commit and during resume. Before ACK of a referencing audit fact, DSH requires the owning Session receipt and rechecks the stored bytes and SHA-256; missing or changed blobs stop the stream. Exporting these artifacts is a separate step.

## Model Experience

### Codex thread continuation

#### What the model sees

Codex sees its persistent thread history and the current DSH function catalog. DSH sends only newly admitted user input through `turn/start` and does not replay its projected transcript.

#### Token effect

Each turn has Codex's native input and output token cost. Diagnostic projection events add no model tokens.

#### KV Cache effect

The provider preserves the Codex thread id through `codex/thread-bound`, the workspace, and native append-only history. Provider prompt-cache availability and eviction remain outside DSH; changing Codex model, instructions, tools, or workspace can invalidate reuse after the changed prefix.

## Known Limitations and Deferred Work

- **Codex runtime compatibility is version-pinned** — upgrading the packaged runtime requires regenerated app-server contract evidence and integration tests before release.
- **Images require host-visible storage** — text and DSH image blocks are mapped natively; an image without an app-server-visible local path, file attachments, and unknown blocks fail before `turn/start`.
- **Interactive requests are conservative** — command/file/permission approvals and request-user-input use the scoped DSH services with durable approval audit. MCP elicitation, dynamic tools, host token refresh, attestation, and secret questions remain fail-closed.
- **Native event projection is structural, not a second model history** — Codex remains authoritative for reasoning and compaction; DSH records and executes the selected tools.
- **Chat Completions exposes function tools only** — Responses tool namespaces are flattened; Responses-hosted tools such as `web_search` have no Chat Completions representation and are rejected, never silently omitted. The DSH-owned Codex thread does not expose native web search.
- **Image input needs a declared vision model** — Chat Completions accepts HTTP(S) or base64 data URLs, not Responses `file_id`; native Responses preserves its image payload. Audio, file, and other undeclared Chat modalities fail explicitly.

### Dev Note

None.

Registered full-agent targets also expose `createImportedAgent(preparation, options?)`. The preparation comes from that target’s reviewed import port; the returned handle owns teardown after the shared Agent factory commits publication. Options carry the destination cwd, unpublished setup and cancellation. Standard and Codex delegate to their existing same-driver creation paths. This common dispatch does not implement cross-driver context projection, attachment installation or archive/workspace transaction rollback.
