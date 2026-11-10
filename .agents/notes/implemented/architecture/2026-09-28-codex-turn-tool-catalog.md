# Agent Note: Snapshot DSH tools for each Codex turn

Status: implemented

## Problem

The Codex fork accepted dynamic tools only at `thread/start`. A DSH agent can acquire or lose scoped tool registrations while retaining the same Codex thread, and resume can restart the app-server after the catalog changed. Supplying only the creation-time catalog would expose stale tools or omit newly available ones. A model-visible catalog also needs a durable DSH record.

## Decision

At every DSH turn, snapshot `ctx.tools.schemas(agent)` for the owning agent scope. Sort function names, detach each JSON schema, and compute a canonical SHA-256 hash over the complete catalog. Persist a versioned `codex/tool-catalog` event before invoking Codex. Send the same catalog in `turn/start.dynamicTools`; an explicit empty array removes inherited dynamic tools for that turn. The fork validates the override and installs it in that turn's context without changing thread defaults. The first turn after resume follows the same path, so it sees current DSH registrations. The app-server handshake enables its experimental API for this field.

## Alternatives considered

**Recreate the Codex thread when tools change.** That would discard or complicate the thread's active history and checkpoint relationship.

**Update only the thread-wide catalog on resume.** This would miss registrations that change during a live thread and couple one turn's tools to later turns.

**Put tool descriptions in user text.** That would modify the user's prompt without granting a callable schema, and would break the exact model-visible audit.

## Consequences

The advertised functions and their hash are reconstructable from DSH Session events. Tool execution remains fail-closed until the later delegated-call steps; this change does not authorize Codex to execute DSH tools or remove its native tools. Tests cover deterministic hashing, DSH catalog refresh, app-server payloads, and model-facing requests from the compiled fork. The fork's per-turn override is intentionally nonpersistent; DSH must provide it on every turn.
