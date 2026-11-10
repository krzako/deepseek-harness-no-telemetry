# Agent Note: Correlate Agent operations across retries and reconnects

Status: implemented

## Problem

One Agent step can issue several physical model requests because of retry, and a reconnect can observe the same in-flight request or tool call again. A thread id alone cannot identify the DSH Session or distinguish a new provider attempt from a repeated observation. Without stable parent ids, audit consumers can double-count an operation or treat a retried tool as safe to execute again.

## Decision

`dsh-agent` owns `AgentTraceCorrelationV1`. It binds every model attempt or model-issued tool call to the DSH `sessionId`, driver key, optional driver-owned `threadId`/`driverTurnId`, and DSH-owned `turnId`/`stepId`. The turn and step ids derive from the Session identity and one-based turn/step numbers with unambiguous tuple encoding; they remain stable across retry and reconnect. The `version` field is explicit on every record.

A model retry keeps the parent scope and receives a new `modelAttemptId`; reconnecting to the same provider request preserves that attempt id. A tool reconnect preserves `toolCallId`; the continuation check refuses an implicit tool retry because side effects require a separate idempotency decision. Driver thread/turn ids never replace DSH Session/turn ids, and import creates a new Session scope rather than claiming the old identity.

This type and its continuation check do not write audit events. The durable event producer must attach them to its own records and validate untrusted wire or stored values at the boundary it owns.

## Alternatives considered

**Use the Codex thread and turn ids as the only correlation.** The standard driver has no Codex thread, and a new DSH Session after import must not inherit the source Session identity. Driver ids remain optional provenance inside the shared record.

**Reuse one model attempt id across retries.** That would make two physical upstream requests indistinguishable and hide costs or partial failures. Reconnect to one physical request, in contrast, deliberately retains the id.

## Consequences

The contract distinguishes a new model dispatch from a duplicate observation and makes an implicit tool retry an error. Auditing and import still need their own persistence, schema validation, and idempotent execution; this pure contract grants none of those guarantees by itself. Focused tests cover retry, reconnect, parent-scope drift, and tool-call identity.
