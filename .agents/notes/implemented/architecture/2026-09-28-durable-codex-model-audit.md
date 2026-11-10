# Agent Note: Persist Codex model traffic before external effects

Status: implemented

## Problem

An authenticated Codex model request can be correlated with a live DSH turn, but correlation alone does not preserve the exact prompt sent by Codex, the translated upstream request, or the model result. Optional four-file diagnostics cannot serve as the Session's required durable audit or a future export and import source.

## Decision

The gateway writes versioned `codex/model-audit` events to the owning DSH Session and awaits its persistence flush at each transport boundary. It records the original Codex request before routing, the actual upstream HTTP request before dispatch, and response headers and raw stream bytes before delivery. The Chat Completions path also records its final translated Responses result and usage before completion is sent to Codex. The pi-ai adapter's per-request fetch hook observes the request after SDK translation without modifying its prompt. A failed audit flush closes the gateway to further model calls.

## Alternatives considered

**Use `CODEX_LOG_REQUESTS` as the audit.** It is opt-in, outside the canonical Session, and captures the Codex-facing exchange rather than the translated upstream HTTP request.

**Reimplement Chat Completions serialization in the gateway.** Duplicating pi-ai's provider transport would make the recorded payload differ from the request actually sent whenever its serialization changes.

**Patch global `fetch`.** A process-global interception would mix unrelated requests and create ambiguous ownership when multiple Codex turns share the process.

## Consequences

The Session contains the original model input, the exact upstream body, and ordered raw output with attempt and turn identity, independent of diagnostic logging. Each streamed chunk incurs a durability barrier and may increase latency; failures intentionally prevent completion rather than leave a silently unaudited result. Real-process tests exercise inference, automatic local compaction, and a retry after an upstream 503; each request crosses the same gateway. Native Responses passes remote-compaction payloads unchanged, but the custom `dsh` provider does not advertise remote compaction yet. Explicit retry idempotency and opt-in remote capability remain separate steps.
