# Agent Note: Session-Affinity Transport Headers for Hand-Declared pi-ai Routes

Status: implemented

English | [中文](2026-09-14-pi-ai-session-affinity-headers.zh.md)

## Problem

A private OpenAI-compatible gateway needs a stable per-conversation identifier on the wire — copilot-proxy keys its conversation records on one — and the harness already owns the right value: the loop stamps every model request with the durable session id at `GenerateOptions.sessionId`, and `dsh-llm-pi-ai` forwards it to pi-ai. pi-ai's `openai-completions` implementation turns that id into session-affinity transport headers whenever a model's compat carries `sendSessionAffinityHeaders`, but DSH's compat gate classified `sendSessionAffinityHeaders` and `sessionAffinityFormat` as `withhold`, so no settings surface could enable them. The id pi-ai already received was dropped on the floor, and requests reached the gateway with no session identity; the gateway's own records could not tell one harness conversation from another.

The `withhold` disposition exists for fields the installed pi-ai catalog already sets for a named vendor — a route reaching for one should be named as that vendor instead. Neither of these fields fits: no catalog entry sets them, pi-ai's detection defaults them off, and a private gateway's URL implies nothing about affinity. The classification was simply wrong for the one surface — a private gateway that must be *told* — the configurable compat exists for.

## Decision

The two fields are offered for `openai-completions` and configurable per route and per model like every other compat switch, on the owning surface described in [[2026-08-18-pi-ai-wire-compat-surface]]:

- `sendSessionAffinityHeaders` — whether a request carrying a session id rides affinity transport headers at all.
- `sessionAffinityFormat` — the spelling: `openrouter` sends `x-session-id`; `openai` sends `session_id` plus `x-client-request-id` and `x-session-affinity`; `openai-nosession` sends that pair without `session_id`.

`sessionAffinityFormat` is derived from pi-ai's own compat type behind a `Record` key drift gate (`PiAiSessionAffinityFormat`), so an upstream format addition fails compilation until named. The fields stay withheld on `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, and `anthropic-messages`: no current consumer speaks them through this route, and a switch a protocol cannot read is refused where it is written rather than silently skipped.

Precedence on the wire stays pi-ai's own: affinity headers are built before the request's `headers` are merged last, so an explicitly configured profile header wins a name collision. A request without a session id sends no header, and a `cacheRetention: none` profile drops the id with the cache — pi-ai treats the id as prompt-cache state — which the wire spec pins so an upgrade cannot change it silently. The session id itself is untouched: no second id is minted anywhere, and the id travels only as transport metadata, never in messages or token accounting.

## Alternatives considered

**Generic header templating** (`headers: {x-session-id: "{sessionId}"}`). A placeholder whitelist, missing-id semantics, and collision rules duplicating what pi-ai already implements, for one gateway's sake. Revisited only if a gateway needs a header name pi-ai's formats cannot spell.

**A `sessionHeader` provider field.** Narrower than templating but still re-teaches the adapter what pi-ai's compat already carries, and cannot spell the `openai` triple. No consumer needs it.

**Keying conversations inside copilot-proxy from its own generated ids.** The gateway would invent identity the harness already owns; records from different harness conversations would merge into one proxy conversation. Rejected in favor of translating the incoming affinity header (the proxy reads `x-session-id` for its `deepseek-harness` source, body metadata still winning).

**Offering the fields for the Responses and Anthropic protocols too.** Deferred until a consumer speaks those protocols through this surface; the gate flip is two lines then.

## Consequences

- A hand-declared completions gateway can be given a stable per-conversation affinity id entirely from `settings.yaml` — `compat: {sendSessionAffinityHeaders: true, sessionAffinityFormat: openrouter}` sends `x-session-id: <session id>` on every request the loop, compaction, and title generation make for that session.
- `copilot-proxy` keys a DeepSeek Harness conversation from the `x-session-id` transport header when no body metadata carries one, and the deployment sends `x-proxy-source: deepseek-harness` as a static profile header so the affinity header is not read as OpenCode's.
- The routing stays opt-in per provider: a route without the switches sends exactly what it sent before, including every OpenAI-compatible gateway that rejects unknown headers.
- Coverage: `tests/session-affinity.spec.ts` asserts the real HTTP wire — stability within a session, separation across sessions, the `openai` spelling set, no id → no header, `cacheRetention: none` → no header, explicit-header precedence, and non-opted-in provider isolation — and `tests/catalog.spec.ts` covers route- and model-level application plus the protocol refusals.
