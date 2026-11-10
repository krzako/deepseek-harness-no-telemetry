# Agent Note: Preserve Codex tool outcomes across interruption and replay

Status: implemented

## Problem

A Codex dynamic tool request can be repeated while the first execution is pending or after a transport reconnect. Running it again can repeat a side effect. Parallel tools and interrupted turns must also retain a valid DSH event order. Image outputs need a lossless bridge from durable DSH attachment references to the app-server's inline format.

## Decision

Index live executions by the stable DSH call ID. A duplicate request with an unresolved live execution awaits the same promise. A completed request replays its committed `tool/result`; a `tool/call` without a result and without a live execution reports `outcome unknown` and never dispatches again. Keep calls independent for parallel execution and wait for outstanding executions before writing `step/end`, including after cancellation. Project text blocks directly and read image attachments with digest verification before creating inline data URLs. The DSH tool runtime materializes policy refusals and cancellation as error outcomes, which are committed before the app-server receives them.

## Alternatives considered

**Retry unresolved calls after reconnect.** This can repeat irreversible side effects when the process stopped between execution and result storage.

**Hold only an in-memory cache.** It cannot replay results after an agent or app-server restart.

**Send filesystem image paths.** They are not durable model-facing content and can reference a different workspace after import.

## Consequences

Tests cover concurrent distinct calls, duplicate in-flight and settled calls, `outcome unknown`, policy refusal, image output, cancellation ordering, and the real fork. The model-visible image bytes are read from verified DSH storage; absent storage fails rather than returning a false success. Audio and other future DSH result modalities remain unsupported until their durable block contracts exist.
