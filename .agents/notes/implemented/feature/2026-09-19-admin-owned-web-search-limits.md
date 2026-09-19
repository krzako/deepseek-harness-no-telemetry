# Agent Note: Administrator-Owned Web Search Limits

Status: implemented

English | [中文](2026-09-19-admin-owned-web-search-limits.zh.md)

## Problem

Search volume and concurrency were fixed inside the model-facing tool configuration. Administrators had no product surface for bounding result context, multi-query fan-out, or total SearXNG pressure. Giving those controls to the model would make resource policy prompt-dependent and enlarge the tool schema. Pagination would also require extra model turns and retained prompt instructions for a use case that can be served by one bounded response.

## Decision

`dsh-web` owns a live `web-search` settings namespace with four positive-integer fields: a 12-source combined result cap, 4 queries per tool call, 4 provider requests running across the Host, and a 30,000 ms search budget. `dsh-tool-web` captures result/query limits and the budget when it registers an agent's search tool. The tool schema remains only `queries`; it has no page, result-count, or concurrency argument.

The Host concurrency gate is a FIFO queue shared by all sessions and agents. Queue wait consumes the existing tool-call budget because the caller's cancellation signal covers acquisition and provider execution. Canceled waiters are removed. A changed concurrency limit controls subsequent admissions without interrupting active requests.

The Plugin configuration page exposes these fields in a **Web Search** card next to the provider-specific **SearXNG** card. Search output always follows the returned sources with advice to refine an irrelevant, broad, or insufficient query instead of repeating it unchanged. That advice belongs to each result rather than the system prompt. Search continues to return SearXNG JSON snippets without pagination; full pages remain the responsibility of `web_fetch`.

## Alternatives considered

**Expose result count and pagination to the model.** This adds schema and prompt complexity, consumes extra turns, and makes typical searches less predictable. A single administrator-sized result set is sufficient, while the model can issue a better query when coverage is poor.

**Apply concurrency per session or tool call.** Independent limits would multiply backend traffic as sessions and agents increase. The policy is intended to protect the shared SearXNG instance, so the queue belongs to the Host service.

**Keep query-refinement advice in the system prompt.** The advice matters only after seeing a concrete result set. Returning it with the sources keeps the standing prompt smaller and places the instruction at the decision point.

## Consequences

- Administrators can tune search context and shared backend pressure without expanding model authority.
- A multi-query call may execute provider requests concurrently, but returns at most the configured combined source count.
- Active tool definitions retain their captured result/query limits and timeout; newly mounted tools use current settings. Host-wide concurrency changes are live.
- The default SearXNG language is `all`, and the provider sends it explicitly on each request.
- Focused service, tool, provider, settings-card, and Web scenario tests cover defaults, validation, FIFO admission, cancellation, prompt/schema boundaries, output guidance, persistence, and language handling.
