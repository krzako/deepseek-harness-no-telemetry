---
description: "The Agent handle, live registry, process-local initiator scope, and agent/* event vocabulary for plugins, UI, and orchestrators building or extending agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent

## Summary

With `dsh-agent` you can create or resume an agent, send a follow-up prompt, steer the current step, inject model-facing context, cancel an activity, and wait until the agent is idle — all through the `Agent` handle every plugin programs against and the live registry (`ctx.agents`) that tracks running agents. The package also carries the process-local initiator scope, which attributes asynchronous work to the agent that started it, and declares the `agent/*` event vocabulary plugins use to observe or intercept work in flight. It has zero loop dependency: concrete creation and driving live in `dsh-agent-loop`, which registers its factory here, so the driver stays swappable. Choose this package when you build UI, hooks, orchestrators, or extension plugins that touch live agents; the interface itself runs no model calls.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-agent` wherever live agents exist: it provides `ctx.agents` and the `Agent` handle that plugins, UI, hooks, and orchestrators work against. The service is inert until a driver registers a factory — the shipped driver is `dsh-agent-loop`, so the smallest useful composition loads both.

### Create or resume an agent

For an imported Session, pass `{ kind: 'import', driverId }` as `ctx.agents.create()`'s `route` after preview and confirmation. The factory checks the destination against any driver recorded in the seed before publication.

Targets expose `describeAuthentication(model)` for local metadata without secret resolution or model calls. Runtime standard targets delegate to the LLM inspector; standalone target factories without an inspector report unverified. Archive preview uses this metadata separately from context compatibility.

Drivers register their paired canonical transfer ports with `ctx.agents.setTransferPorts(driverId, { source, target })` before registering any full-driver factory or selector. The registry checks both port identities, rejects a factory or selector without the pair, and effect-scopes each registration; a transfer coordinator resolves the pair with `getTransferPorts(driverId)` and then uses the shared `prepareAgentTransfer()` flow. Provider names do not determine transfer behavior.

`PortableAgentContextStreamV1` represents the same canonical V1 fields with single-consumption item, effective-ID, and compaction iterables. `PortableAgentStreamBundleV1` pairs it with optional resident private state or a `PortablePrivateSnapshotStreamV1` whose source has validated the exact JSON context bytes. Its per-entry validators let an archive encoder reject malformed items and references without retaining the entire item array. A source port can implement `exportPortableContextStream()` for ZIP export; the resident `exportPortableContext()` remains required for import preview and for drivers without a stream producer. The source must capture completed-turn data before returning because ZIP consumption follows the durable-log consistency check. The standard driver projects ZIP items from a frozen Session event snapshot, while its import-preview method still returns a complete context value.

`PortableOpaqueContextItemStreamV1` transports one opaque item as source-validated JSON bytes with a size and SHA-256 receipt. It is only an in-process stream representation: the archive contains the ordinary V1 opaque content block. The source must validate exactly one lossless JSON value before exposing the bytes; the consumer verifies the receipt at EOF. Opaque JSON retains its original spelling and contains no canonical attachment blocks.


The transfer preview distinguishes unsupported opaque blocks in the effective model-visible history from opaque historical or compaction provenance. An unsupported active block blocks portable import; unsupported inactive provenance requires an explicit warning acknowledgment. A compatible same-driver private checkpoint retains both without a namespace warning. Changing driver or model makes the private checkpoint unavailable and restores the portable-content checks.

When a portable context cites attachments, the caller passes destination-resolved image/file references as the optional final `prepareAgentTransfer()` argument. The coordinator snapshots that map for the reviewed transfer and passes it only to the destination port at commit; the registry does not retain archive-specific attachment state.

`ctx.agents.create()` builds a fresh agent and session under one identity; `ctx.agents.resume()` loads a persisted session and rebuilds the agent on it. Both delegate to the registered factory and return an `AgentHandle` — the only object that can tear that agent down. `get(id)`, `list()`, and `roots()` find live agents, and `isOwnedBy(id, owner)` tells whether one agent was created through another's scoped context.

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})
// later:
await handle.dispose()   // stops the loop, unregisters, removes the session, unwinds the scope
```

`AgentOptions` supplies the initial provider/model route, optional adapter-owned `reasoningEffort`, and optional positive `maxTokens` output cap. The loop validates exact-model reasoning support, resolves adapter defaults, records the effective values in the request header, and applies them to each conversation request. An optional `setup(agentCtx)` callback composes the agent's scoped world before it is published — scoped tools, prompt sections, and listeners exist before any creation announcement. Setup is composition-only: drive the agent only after creation resolves.

### Drive an agent's conversation

The handle's methods route identified user-role messages into the agent's inbox. `followup()` queues an ordinary next-turn prompt and wakes the driver; `steer()` submits next-step input and wakes it; `inject()` adds model-facing context without waking the driver, so it lands in the next admitted step. `cancel(cause)` aborts the active activity and, unless `keepInbox` is set, clears pending work; `whenIdle()` resolves after the whole agent reaches quiescence.

```text
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },
})
handle.agent.steer({
  content: [{ type: 'text', text: 'Focus on the tests.' }],
  source: { kind: 'plugin', plugin: 'my-plugin' },
})
await handle.agent.whenIdle()
```

### Scope registrations to one agent

`Agent.ctx` is the agent's scoped context: registrations made through it (tools, prompt sections, variables, event listeners, restrictions) apply to that agent alone and unwind on disposal. The same mechanism is what agent presets use to give one session a different capability set without affecting its neighbors.

### Intercept or observe work in flight

The `agent/*` events let plugins act on live work without depending on the loop package. `agent/pre-step` can reject a proposed step or replace the messages entering it; `agent/request-error` lets a listener retry a failed model request; `agent/turn-stopping` runs before an otherwise completed turn closes and can steer to keep it open. `agent/assistant-stream` carries one process-local Assistant attempt's ordered start, transient chunk, and end frames. Start names the attempt's turn and step, chunk indexes are dense from zero, and `end.index` is the next chunk position. The loop commits the complete compact stream as one `assistant/message` or `assistant/attempt` before a committed end frame, so the live event remains presentation data rather than the replay source. `agent/status`, `agent/created`, and `agent/disposed` drive UI and coordination state, and the per-message `agent/inbox/*` notifications keep inbox projections in sync. Exact signatures, dispatch modes, and payload contracts live in the generated region of the [core subsystem page](../../../docs/subsystems/core.md#cordis-surface).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is built on one separation: the public `Agent` surface and registry live here, while construction and driving live in the loop package behind a registered factory. Consumers therefore depend on `dsh-agent` and never on `dsh-agent-loop`, keeping the driver swappable. The second idea is the initiator scope: an `AsyncLocalStorage` chain that carries the exact live `Agent` through the asynchronous driver work it starts, so helpers below a driver can attribute their work without forwarding the agent through every call.

### Step admission

`PreStepDecision` is either `{ kind: 'reject' }` or `{ kind: 'enter', messages, startsRequestSeries? }`. The enter branch contains the complete identified, frozen message batch. `startsRequestSeries: true` declares a distinct model-message series; a wrapping listener preserves that declaration and the batch unless it intentionally replaces either one. Claiming removes offered messages from the inbox, while messages inserted after the claim remain pending for a later boundary.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `AgentRegistry`, factory slot, initiator scope, `CreateAgentOptions`/`ResumeAgentOptions` |
| [`src/runtime-types.ts`](src/runtime-types.ts) | `Agent`, `AgentStatus`, and the `agent/*` event declarations |
| [`src/types.ts`](src/types.ts) | `AgentOptions`, cancellation causes, and inbox vocabulary |
| [`src/inbox.ts`](src/inbox.ts) | The `Inbox` projection over durable `agent/inbox/spliced` events |
| [`src/dispatch.ts`](src/dispatch.ts) | `agentEvents` fused dispatcher and `assembleContextFor(agent)` |
| [`src/consumed-work.ts`](src/consumed-work.ts) | `foldConsumedWork(events)`: what the log's consumed work became |
| [`src/model-selection.ts`](src/model-selection.ts) | `installModelSelection`: coupling one selection to assembly and routing |
| [`src/trace-correlation.ts`](src/trace-correlation.ts) | Versioned DSH turn/step identities and retry/reconnect correlation checks |
| [`src/portable-session.ts`](src/portable-session.ts) | Versioned driver state, portable context, private checkpoint envelope, and import assessment |
| [`src/session-transfer.ts`](src/session-transfer.ts) | Driver-neutral export, compatibility preview, and one-shot destination-port dispatch |
| [`src/standard-session-export.ts`](src/standard-session-export.ts) | Standard Session projection into portable context |
| [`src/standard-session-import.ts`](src/standard-session-import.ts) | Portable effective context projection into standard-driver inputs |
| [`src/standard-transfer-ports.ts`](src/standard-transfer-ports.ts) | Standard source and target adapters for the shared transfer ports |
| [`src/standard-import-seed.ts`](src/standard-import-seed.ts) | Replay-valid standard Session seed from prepared effective history |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: no-op `agent/status` transitions fail |

### Registry and lifecycle

`AgentRegistry` keeps one entry per live agent with its carrier and creator relation. `register()` records an already-constructed agent; the async factory uses the split `enter()`/`announce()` pair so setup and publication stay rollback-covered. A detach requested during a creation dispatch waits for that dispatch to unwind, and each detach is bound to the exact entry, so a stale disposer cannot remove a later same-id replacement. Teardown order is stop-and-drain the loop, unwind the scope, detach the agent, detach the session; the id becomes reusable after private cleanup.

An exact provider driver registered with `setDriverFactory()` takes precedence over the optional `setDriverSelector()` policy. The selector may choose a full driver for another provider route before the standard loop is constructed; returning `undefined` leaves the standard loop in charge. Both registrations follow their owner effects.

Every full driver, factory, and selector declares the same stable `driverId` independent of the model provider; `standard` is reserved for the built-in loop. Resume and import compare that identity before constructing an external driver. The lifecycle records `agent/driver-selected` before starting the driver and refuses a resume that selects a different implementation; changing a model route does not change that identity.

`AgentDriverRoute` distinguishes policy-based creation, resume with a persisted driver, and import with an explicit destination driver. The source port must reject export during an active turn. `prepareAgentTransfer()` validates the exported context, checks the explicitly selected destination model against the target catalog at preview and commit, and holds the destination import call until blocking errors are absent and warnings are acknowledged. A model change requires acknowledgment and prevents forwarding a source-model private checkpoint; an unavailable selected model blocks import. The caller supplies a fresh target Session id; the transfer creates stable lineage (`sourceSessionId`, `sourceDriverId`, `importId`) and passes it with the selected model to the target port at most once. It never dispatches by source/target pair or switches the source driver in place. The returned target preparation is not yet a created or durable Session; the importer owns that later lifecycle transaction and must persist the lineage.

The required source method `exportArchivedContext()` projects an explicitly supplied detached Session using only the supplied artifact reader. It must not resolve a live Session or read local artifacts. `verifyArchivedAgentContext()` compares the entire resulting bundle, including private state, with the archived bundle and rejects source identity mismatch or Session mutation. This source-only operation does not invoke the target port.

`projectStandardSession()` reads a completed standard Session without executing work. It preserves logged messages, attachment references, tool-call/result blocks, shadowed messages, the latest system instruction, and effective order after surface replacements. It rejects an open turn, unfinished compaction, missing request header, foreign driver selection, or content block without a portable mapping. The caller still must package referenced attachment bytes and implement the source port and destination import transaction; this projection alone is not a downloadable archive or an importable Session.

`projectStandardImport()` validates a portable context and prepares its effective entries in order, keeping system/developer instructions separate from standard messages. The caller supplies complete attachment references and the destination model route; a missing or inconsistent attachment, unsupported content, or tool block in the wrong role fails before Session creation. The projection assigns deterministic new message ids but creates no Session and never re-executes a historical tool or model call. The import transaction must retain the original canonical context for provenance and decide how the destination driver handles the separate instruction entries.

`standardTransferSource()` resolves a complete standard Session and rejects a missing, misidentified, or active source. Both resident and streamed exports preserve recorded header import lineage in the canonical source metadata; sessions without recorded lineage omit that field. `standardTransferTarget()` reads its current model catalog asynchronously at preview and again at commit, then prepares the canonical context, selected model, lineage, and effective standard inputs. The shared coordinator can call these ports for same-driver or cross-driver transfer. The target result remains unpublished; a later transaction must create the Session, persist its ancestry and attach archived bytes.

`buildStandardImportSeed()` turns prepared messages into a replay-valid new Session log with balanced synthetic turns, steps, tool calls and results. It records historical calls but never executes them, and rejects orphan results or unresolved calls. It returns source instruction entries separately; the importing runtime must install them with their proper role before publishing the Session or reject the import. The seed alone does not create a live agent or persist lineage.

For standard → standard transfer, the seed builder also retains the source system instruction verbatim in the initial request header, including `{{...}}`. It rejects developer or non-text instruction blocks that cannot occupy the standard system role; the runtime still must install that instruction as a literal prompt section.

### Initiator scope

Each driver runs its complete lifetime inside `ctx.agents.withInitiator(agent, ...)`, so inherited async chains observe that agent; `withoutInitiator()` hides it for unrelated process-local work such as shared timers. The boundary is process-local attribution only — ambient presence is neither liveness proof nor authorization, and explicit identity stays authoritative at worker, process, persistence, and wire boundaries. Teardown rejects new boundaries, lets returned-Promise boundaries drain, then disables the underlying storage. The [initiator-scope decision](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) owns the detailed contract.

### Ownership invariants

The `AgentHandle` disposer is a capability: among consumers, only its holder can tear the agent down. The registered factory provider is a structural co-owner, because scoped agents depend on that provider's service API; provider unload stops and drains every live handle it made. `ctx.agents.get(id)` still returns a bare `Agent` — the handle is exposed only to the consumer that created it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [Core subsystem](../../../docs/subsystems/core.md) — the loop map, `Agent` handle, interception decisions, and generated service API.
- [agent-loop package](../agent-loop/README.md) — the default driver that creates, drives, and disposes agents.
- [Session subsystem](../../../docs/subsystems/session.md) — the durable log and derived history behind the handle.
- [Initiator-scope Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) — the boundary and teardown contract.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### User, steering, and injected messages

#### What the model sees

`followup`, `steer`, and `inject` feed the owning session as identified user-role messages; accepted content becomes part of the derived history the model reads on later steps. `agent/pre-step` and the other declared events let plugins reject a proposed step or add durable request material; this interface contributes no fixed prose itself.

#### Token effect

Accepted content becomes retained history or a repeated session prefix; blocked content contributes no request tokens. Size is caller- and plugin-dependent.

#### KV Cache effect

Accepted history and steering are append-only; a blocked submission sends no request. A session prefix remains stable within its loop instance, while a new or resumed instance may establish a different prefix.

### Agent-scoped request composition

#### What the model sees

Registrations through `agent.ctx` can shadow prompt sections or tools and can install agent-only interceptors during unpublished setup, so one agent sees a different prompt and tool set than its neighbors.

#### Token effect

The package adds zero tokens itself; scoped contributions affect only that agent and disappear on disposal.

#### KV Cache effect

Prefix-stable while an agent's scoped registrations are unchanged. Setup or reload that changes prompt sections, tool definitions, or request listeners may invalidate reuse from the first affected request token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package needs special care. They are current package constraints, not a task backlog.

- **Initiator scope is process-local** — workers, child processes, HTTP, durable queues, and restarts must materialize any required identity explicitly.
- **Ambient identity may outlive liveness** — consumers still check `agent.status`, cancellation, and the owning capability contract before lifecycle-sensitive work.
- **`agent/session-start` cannot gate startup** — it remains a synchronous, veto-less notification; async composition that must finish before publication belongs in the factory's `setup(agentCtx)` transaction instead.
- **`cancel()` clears the inbox by default** — it aborts the in-flight turn plus queued and steering work; `cancel(cause, { keepInbox: true })` aborts only the turn and preserves pending items, and there is no step-only abort that keeps the turn running.
- **Each additional `UserMessage` carries exactly one `MessageSource`** — contributions from several plugins merged onto one message collapse under one source, so the message cannot name several producers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided directions: inter-agent channels beyond delegation — shared state, streaming child output, and background or poll semantics remain outside the current delegation seam; and the `SessionStartSource` values `'clear'`/`'compact'` are reserved with no emitter yet, pending the driving subsystems.

</details>

Registered full-agent targets also expose `createImportedAgent(preparation, options?)`. The preparation comes from that target’s reviewed import port; the returned handle owns teardown after the shared Agent factory commits publication. Options carry the destination cwd, unpublished setup and cancellation. Standard and Codex delegate to their existing same-driver creation paths. This common dispatch does not implement cross-driver context projection, attachment installation or archive/workspace transaction rollback.

Resolved transfer attachments use `portableAttachmentKey` (id, media type, optional name), not digest alone. This preserves identical bytes used as an image and a file or with several explicit filenames without overwriting references; the canonical archive format is unchanged. Archive resolution uses validated logged metadata, canonical image display names, and exactly one matching file reference. Missing metadata or an unnamed file with several candidates rejects explicitly. Resolution only prepares detached references; attachment restoration must finish before Session publication.
