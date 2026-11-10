# Agent Note: Persist the Agent driver separately from its model route

Status: implemented

## Problem

A provider/model name can exist under the standard loop and the Codex driver. Selecting a driver again from current settings on resume can silently change which loop owns an existing Session, especially when `codex.enabled` changes. A Codex thread binding identifies a thread but does not record the original full-agent choice before that binding exists.

## Decision

Every full `AgentDriver` reports a stable `driverId`, distinct from the provider/model route. The shared lifecycle appends the versioned `agent/driver-selected` event to the Session before starting the driver and, when persistence is mounted, flushes it before an external runtime starts. The standard loop records `standard`, a reserved id no external driver may use; the Codex driver records `codex`. Resume requires the selected implementation to match the recorded id. A legacy log without the event records the first choice on resume; existing turn history and Codex thread binding still constrain that choice.

The Codex selector treats `codex.enabled` as a policy for fresh, unbound Sessions only. A persisted `codex` selection continues through Codex when the setting is off; a persisted `standard` selection cannot be taken over by Codex when the setting turns on. If a required driver is unavailable, resume fails instead of starting the wrong loop.

## Alternatives considered

**Infer the driver from the model provider string.** The same provider/model labels can be configured for multiple agents, and selection settings can change. A route name is not a durable agent identity.

**Infer Codex only from `codex/thread-bound`.** A crash can occur after driver selection but before thread binding. The selection event is flushed before that external step.

## Consequences

Existing Sessions retain their owner through settings changes, and missing implementations fail loudly. Driver selection adds one durable event and one pre-start flush when persistence exists. Focused tests cover a persisted resume after disabling the selector, refusal when the saved driver is unavailable, and both directions of the Codex setting change.
