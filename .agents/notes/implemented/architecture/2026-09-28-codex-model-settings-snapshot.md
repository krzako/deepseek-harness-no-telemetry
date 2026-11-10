# Agent Note: One Codex provider snapshot per model attempt

Status: implemented

## Problem

The gateway previously read `codex.providers` separately to resolve the model route and wire format, while its long-lived Chat Completions adapter read the provider catalog again when a stream began. An edit between those reads could mix one route with another endpoint, model declaration, or API format. An in-flight stream also needed to remain stable when settings changed.

## Decision

After accepting and auditing a Codex request, DSH captures one settings snapshot for that physical model attempt. It resolves the provider and model from that snapshot and constructs a request-scoped Chat Completions adapter when required. Native Responses uses the same captured provider profile. The durable upstream-request entry records the resolved provider, model, and effective API format beside the actual HTTP request; it does not copy credentials. The referenced API credential is resolved immediately before upstream dispatch, once for that attempt. The next request, including a Codex retry, captures fresh settings and credentials. Omitted `apiFormat` means Chat Completions; `responses` selects native passthrough.

## Alternatives considered

**Cache the provider catalog for the lifetime of the app-server.** That would require a restart for ordinary settings edits and would not reflect credential rotation.

**Read settings independently at each conversion stage.** That could combine incompatible revisions within one model attempt.

## Consequences

Editing or removing a provider does not rewrite an already-running attempt, but a new attempt observes the change and rejects a model no longer configured. Secret values are not stored in the settings snapshot or audit. Tests cover changing a route from default Chat Completions to native Responses, changing its credential reference, rotating the credential value, and removing the selected model between attempts.
