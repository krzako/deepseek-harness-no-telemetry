# Agent Note: Preserve unmapped Codex history in portable context

Status: implemented

## Problem

Codex V2 checkpoints retain Responses history with text, reasoning, function calls, tool results, multimodal content, and fork-specific fields. The canonical DSH context has a smaller vocabulary. Guessing a tool result's success from its wire output or dropping unknown content would make cross-driver transfer appear more faithful than it is.

## Decision

`projectCodexResponseItem` maps fields with direct canonical equivalents and retains every other JSON value as a `codex.responses.v1` opaque block. `codexPortableToolOutcomes` joins a durable Codex call binding to the matching DSH tool result, rejects duplicate or mismatched outcomes, and leaves an unfinished call unresolved. Function outputs require that audited outcome before they become canonical tool results; otherwise the entire output item remains opaque. `projectCodexEffectiveHistory` first verifies the V2 checkpoint's content hashes and compaction references, then projects its active model-visible items in order. `projectCodexHistoricalItems` projects every rollout Responses item and installed replacement history in rollout order, with disjoint IDs and compaction output references; non-history rollout events remain in the private checkpoint. Neither projection alone claims complete compaction ancestry. The stable canonical item ID derives from checkpoint order, while the Responses ID remains provenance. The source transfer port remains separate work.

`resolveCodexInstalledCompactions` associates each installed checkpoint compaction with every durable request and success/failure attempt, plus its pending and installed history. It resolves full payloads through a session-owned artifact resolver, preserves retries, and rejects missing or reordered facts. This produces provenance for later canonical ancestry without invoking any historical model or tool operation.

`projectCodexCompactionAncestry` derives local/remote mode from each audited prompt, projects the last successful request's input, retains every retry prompt and settlement as opaque provenance, and links outputs to the rollout projection. It refuses missing or inconsistent implementation metadata. A later source port must combine these items with the active history and driver state.

`projectCodexPortableBundle` now combines those parts with the persisted source driver state and intact V2 checkpoint, then validates the complete canonical context. The source port remains responsible for a completed-session read barrier and obtaining the latest mutually consistent inputs.

`selectCodexPortableSourceFacts` establishes the source-side terminal identity from a durable Session: a single Codex driver and thread, the last successful closed turn, its unique Codex turn binding, and a final checkpoint fact after a gap-free audit with no pending compaction. It refuses partial turns and mismatched facts before any checkpoint artifact is read.

`codexPortablePayloadResolver` checks a Session-owned receipt, exact media type and byte count, and SHA-256 before parsing an audit artifact. It constructs the attachment reference from the digest, never from payload paths. The common in-memory bundle port still limits the scalability of very large checkpoint projection; this helper does not itself provide a streaming archive path.

`codexPortableDriverState` records the source provider/model from the last audited inference upstream request of the selected turn (or a compaction-only request) and the fork identity from the durable thread binding. It refuses routes after the terminal checkpoint and does not read current settings, so a later settings edit cannot change export provenance.

`readCodexPortableBundle` joins the terminal Session selection, session-owned artifact resolution, checkpoint and compaction audit verification, source route, tool outcomes, and canonical projection. It requires the caller to supply a flushed or detached Session and rejects a concurrent append; it does not register a transfer port or replay historical work. The common bundle and artifact JSON remain in memory until the streaming transfer port is implemented.

## Alternatives considered

**Treat every result as success.** Responses function-output serialization does not carry a reliable error bit; this would falsify failed tool executions.

**Drop unknown variants.** A future model response or multimodal result could then disappear from the imported context without a compatibility warning.

## Consequences

Simple text and function calls can enter the common context without interpreting Codex rollout internals. Unsupported content remains inspectable, and the target driver must explicitly assess opaque namespaces. Tests cover known items, nested multimodal output, missing outcome, unknown variants, malformed identifiers, inconsistent durable tool results, active-history order, rollout order, replacement output references, and a corrupted V2 checkpoint. Linking historical inputs and audited compaction prompts/results remains necessary before exporting a complete portable context.
