# Agent Note: Version Codex audit facts before transport

Status: implemented

## Problem

The live gateway audit records raw transport phases, while model-visible Codex prompts, tool decisions, compaction replacement history, and checkpoints need a common durable shape before a replayable app-server channel can carry them. Unvalidated arbitrary JSON or absolute artifact paths would make import and retry ambiguous.

## Decision

`codex/audit-v1` is a discriminated event contract with one thread-local positive sequence, stable event ID, DSH turn, and optional Codex turn ID. Distinct variants cover model request/stream/result/failure, tool request/approval/result, compaction request/result/pending/installed/failure, context configuration, and checkpoint. The parser rejects unknown fields and versions. Content is either lossless inline JSON or an artifact identity with SHA-256, byte count, and media type; events never contain a host storage path or public URL. The checkpoint additionally names the hash of its effective history. A pending compaction reserves one effective history; the next new event must be an installation with the same compaction ID and identical payload. The Session log restores this obligation after restart, so a new turn cannot proceed across an unresolved history replacement.

Browser inspection addresses an artifact by Session ID, audit event ID, and digest rather than by a global attachment URL. The Host requires a fact and matching receipt in that Session, streams from the attachment store, and verifies the final hash and byte count. The Client publishes text only after the stream completes; a failed verification never reveals partial content in Trajectory.

## Alternatives considered

**Extend `codex/model-audit` with arbitrary phases.** That event is gateway-local and does not carry a fork-owned sequence or a typed compaction/checkpoint relationship.

**Put file paths or public attachment URLs in each event.** They would couple an export to one installation or allow a digest found in one Session to address another Session's content.

**Treat `compaction/installed` as an isolated fact.** A crash after replacing live history but before sending that fact would let the next turn proceed without an auditable resolution. A durable pending fact blocks that gap until the fork and DSH reconcile it.

## Consequences

The app-server receiver validates each event, serializes concurrent requests, and acknowledges a new sequence only after the owning Session flush succeeds. It reconstructs the cursor and any pending compaction from persisted events, returns the original ACK for an identical retry, and rejects gaps, conflicts, wrong threads, unmatched compaction installations, and failed storage without admitting later facts. The fork's per-thread disk spool records each event before sending it; on `turn/start` the DSH client supplies the owning Session and turn, and the fork reconciles its spool with the DSH cursor before submitting work. A lost ACK is recovered from the cursor without a second append. Tests cover event validation, replay, flush ordering, pending-compaction blocking, and spool crash/reconnect. The pending protocol does not itself install a checkpoint or resolve an interrupted compaction; fork-side reconciliation and the artifact store remain separate work. The current gateway model audit remains active.

Artifact receipt commit and resume use the same metadata validator, including a runtime version check on persisted data. The V1 TypeScript declaration does not establish the version of bytes read from a Session log. Receiver tests reject unsupported numeric versions, a string version and null before resume can acknowledge work.
