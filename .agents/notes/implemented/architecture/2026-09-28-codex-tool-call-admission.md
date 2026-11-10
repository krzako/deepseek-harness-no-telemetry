# Agent Note: Admit Codex tool calls against the DSH catalog

Status: implemented

## Problem

Advertising DSH functions to Codex is not enough to execute them safely. The app-server's `item/tool/call` request can arrive after a tool is removed or replaced, can name a function that was not advertised for the current turn, or can carry arguments outside its schema. Codex `callId` also needs an unambiguous DSH identity before the later durable execution pipeline is added.

## Decision

Route the existing app-server request through the owning Codex agent. Require its active thread and turn, a flat function name present in the turn's catalog, current visibility in `ctx.tools.get(name, agent)`, and an unchanged definition. Validate object arguments against the advertised JSON Schema. Derive a stable branded DSH tool-call ID from DSH session, Codex turn and Codex call IDs, and record a versioned `codex/tool-call-bound` event with the catalog hash and arguments. Repeated identical calls retain the identity without duplicating the binding; changed payloads under one `callId` fail. Until the next execution step, a validated call still receives an explicit error and cannot invoke a tool.

## Alternatives considered

**Validate only against the live registry.** A tool added after the model request was sent would become callable despite never appearing in that request.

**Validate only against the admitted snapshot.** A revoked tool could still run after its scope changed.

**Use Codex `callId` as DSH identity directly.** Its uniqueness is only local to Codex, and it can collide across turns or sessions.

## Consequences

The eventual executor receives a validated, correlated call without a second agent loop. This step does not execute DSH tools, flush the call event before side effects, or return tool results; those belong to the subsequent durable execution step. Tests cover protocol routing, schema and scope refusals, stable IDs, repeated-call conflicts, and a real fork app-server tool-call request.
