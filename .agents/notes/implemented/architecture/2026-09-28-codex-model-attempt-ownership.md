# Agent Note: Codex owns model retry and DSH enforces attempt identity

Status: implemented

## Problem

Codex can retry a failed model stream while the DSH gateway and an upstream provider also have their own transport behavior. Without a distinct identity for each physical Codex request, DSH cannot distinguish an intentional new attempt from a duplicate delivery or prevent the latter from issuing another upstream call. A disconnected gateway client can also leave the upstream stream running or let DSH buffer its output without limit.

## Decision

Codex remains the owner of model retries. Its DSH provider disables the inner HTTP request retry but retains Codex's stream-level decision to make another request. The fork puts a fresh UUID in `x-dsh-model-attempt-id` for each Responses HTTP request. DSH requires that identifier, correlates it with the active Session and turn, and rejects an identifier already recorded in that Session before another upstream dispatch. Each new retry gets a new identifier and a separate durable audit. DSH propagates client cancellation and configured provider timeout to upstream, waits for downstream drain, and records incomplete streams before ending them.

## Alternatives considered

**Let DSH retry failed provider calls.** This would create a second retry owner behind Codex's loop and hide request attempts from its decisions.

**Use Codex's `x-client-request-id` as the attempt key.** That header identifies the thread and is reused across model requests.

**Hash the request body.** Identical prompts can be intentional retries or separate turns, while distinct payloads can still represent one transport retry. Content equality is not attempt identity.

## Consequences

The same attempt UUID is admitted at most once by an owning DSH Session, including after a process restart that retains its log. A repeated UUID is rejected, not replayed; a caller that needs a fresh model attempt must let Codex create a new UUID. Aborting a request cannot prove whether a remote provider already charged for it, so the audit marks its stream incomplete rather than claiming rollback. Waiting for `drain` bounds the gateway's own response buffer but does not impose an archive-size limit.
