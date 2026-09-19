---
description: "The ctx.web search and fetch service and provider selection."
kind: "package-reference"
---

# @deepseek-ai/dsh-web

English | [中文](README.zh.md)

## Summary

`dsh-web` provides `ctx.web.search()` and `ctx.web.fetch()` with separate provider registries. It selects one usable provider for each capability at call time and reports structured `WebError` failures. The service makes no network requests itself and registers no model-facing tool.

## Use this package

Mount the service with search and fetch providers. A single usable provider for each capability is selected automatically; configure `searchProvider` / `DSH_WEB_SEARCH_PROVIDER` or `fetchProvider` / `DSH_WEB_FETCH_PROVIDER` to choose an id explicitly.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

A provider registers through `registerSearchProvider` or `registerFetchProvider`. Call `ctx.web.search({ query, maxResults }, signal)` or `ctx.web.fetch({ url }, signal)`. Both forward cancellation. Search results are capped by the service; fetch returns the final URL, HTTP status, decoded body, and truncation flag.

The service owns the live `web-search` administrator settings namespace. Its defaults are 12 combined sources per `web_search` call, 4 queries per call, 4 provider search requests running across the Host, and a 30,000 ms search tool budget. The Host-wide concurrency gate is FIFO, includes every session and agent, removes canceled waiters, and applies changed limits to subsequent admissions. The model does not receive controls for these limits.

The generated `web/testSearchConnection` Remote operation forwards transient form options to the selected provider and runs one cancellable search with a one-result bound, without saving those options. A successfully decoded empty result counts as a successful connection; provider and transport failures remain failed Remote calls.

## Model Experience

Indirectly, through `dsh-tool-web`, which owns the model-facing search and fetch schemas, prompt guidance, and rendered results.

#### KV Cache effect

No direct invalidation; retained tool results change only when a consumer executes a web request and logs its output.

## Known Limitations and Deferred Work

Without a usable provider, calls fail with `WEB_PROVIDER_UNAVAILABLE`; ambiguous or configured unavailable providers fail with their corresponding `WebError` codes.
