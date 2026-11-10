# Agent Note: Version portable Agent Session data

Status: implemented

## Problem

The existing Session log preserves DSH events, while Codex keeps its next-request context in a separate rollout. A transcript alone cannot describe the effective context after compaction or tell another driver whether a native item can be interpreted. A ZIP without a manifest cannot prove that its referenced payloads are complete and unchanged.

## Decision

`dsh-agent` exports version-one driver state separately from provider/model selection and a portable context containing ordered historical items, effective item ids, and compaction input/output references. The context retains opaque namespaced JSON instead of dropping it. Import assessment compares a target's declared capabilities with the context: unsupported opaque content in the effective history blocks portable import, while unsupported inactive provenance requires explicit acknowledgment. A compatible same-driver private checkpoint carries both exactly and does not need a canonical opaque namespace declaration. Driver changes and model changes remain explicit warnings; an unavailable model blocks import. A driver-owned checkpoint occupies a versioned private slot and is never passed off as another driver's state.

`dsh-agent-codex` defines a validated private checkpoint with native rollout items, effective order, compaction prompt/result facts, and prompt-affecting configuration. `dsh-session-log-export` defines a manifest of typed paths, byte counts, SHA-256 digests, and workspace fingerprint/snapshot metadata. Its validator rejects path traversal, duplicate paths, and missing required payloads. The current log download does not yet emit this manifest or capture the checkpoint; these schemas do not claim working restore.

## Import compatibility

| Source archive | Target capability | Planned fidelity |
| --- | --- | --- |
| Manifest v1 and compatible private checkpoint | Same driver and checkpoint version | Same-driver context; model and workspace still require review |
| Manifest v1 without compatible private checkpoint | Any driver supporting portable v1 | Portable context with explicit private-state warning |
| Manifest v1 with unsupported active opaque block or unknown version | Any driver lacking the declared capability | Refuse portable import until a capability or explicit transformation exists; a compatible same-driver private checkpoint retains active opaque content |
| Manifest v1 with unsupported opaque content only in inactive history or compaction provenance | Different driver or no compatible private checkpoint | Portable import only after an explicit warning that provenance may not be interpreted |
| Existing log-only ZIP without manifest | Any driver | Neutral transcript only after validating the Session log; no exact-context promise |

These rows describe the import contract, not an enabled importer. The workspace presence/snapshot decision is independent of driver compatibility; all four workspace combinations remain admissible with the warnings and file-replacement choices defined by the integration plan.

## Alternatives considered

**Use the projected transcript as the transfer format.** It loses effective post-compaction context, native model items, and some tool semantics. The separate portable item list preserves those facts and makes unsupported content explicit.

**Use the Codex rollout as the common format.** Standard and future drivers would need Codex-specific readers. The private checkpoint instead supplements one provider-neutral context.

## Consequences

The parsers give later export/import work one versioned target and reject malformed references before execution. They do not verify ZIP payload hashes, convert live DSH/Codex state, or perform import; those operations remain owned by the export/import pipeline. Focused tests cover valid state, compaction references, opaque-content refusal, checkpoint validation, and manifest integrity rules.
