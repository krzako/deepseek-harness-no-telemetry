# Agent Note: Bind Codex model requests to a live DSH turn

Status: implemented

## Problem

One Codex app-server process serves several DSH agents. Its shared gateway credential proves that a request came from that process, but not which DSH Session owns a particular model request. A stale thread or fabricated turn could otherwise use any configured upstream model route without a live DSH turn.

## Decision

The gateway requires Codex's turn metadata on every Responses request after checking the shared credential. It accepts only `turn` and `compaction` purposes with nonempty Codex session, thread, and turn identities. When the body also carries Codex turn metadata, those identity fields must agree with the HTTP header. The provider resolves the thread to a registered `CodexAgent`, which admits the request only during its active DSH turn and rejects a known different or completed Codex turn. The gateway creates a distinct DSH attempt id after admission and records the complete correlation in the optional four-file diagnostic log.

## Alternatives considered

**Trust the process token alone.** A process-wide secret cannot distinguish concurrent threads or detect a request that arrives after its owning turn completes.

**Infer the owner from the model id.** Multiple sessions can select the same model, and one session can change models between turns. Provider/model is not a Session identity.

## Consequences

Unknown, stale, or unsupported requests fail before an upstream model call. The admitted correlation anchors a separate durable `codex/model-audit` stream in the owning Session; stable retry ownership remains separate work. Tests cover accepted inference and compaction, missing and mismatched metadata, unknown threads and turns, and the absence of upstream calls on rejection.
