# Agent Note: Codex portable import preparation

Status: implemented

## Problem

The shared transfer API needs both source and target ports for each full agent. Codex can export a canonical context and private V2 checkpoint, but the fork does not yet expose a transaction that creates a fresh thread from them. Advertising restoration before that transaction exists would misrepresent an import preview as a resumed agent.

## Decision

`codexTransferTarget()` is an unpublished preparation stage. It declares the configured target model routes and one supported fork revision for private V2 state. It validates the canonical context, fresh destination Session ID, lineage, route, and checkpoint version and self-hashes, then freezes a copy for the later Session and thread transaction. It performs no model request, tool call, Session mutation, or fork-thread creation. The source and target factories remain unregistered until the restoration path can consume the preparation.

## Alternatives considered

Registering only the source port violates the shared registry's paired-driver rule. Registering both factories before the fork can hydrate a thread would make export available while import still stops at preparation; the runtime therefore keeps them unregistered.

## Consequences

The shared compatibility assessment can distinguish a compatible same-driver V2 checkpoint from a model or revision change. A route removed between preview and commit is rejected. The preparation alone is not an import and does not promise that the fork can hydrate a new thread; that requires the separate fork API and a tested Session creation transaction.
