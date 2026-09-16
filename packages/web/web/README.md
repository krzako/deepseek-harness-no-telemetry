---
description: "The ctx.web fetch service and provider selection."
kind: "package-reference"
---

# @deepseek-ai/dsh-web

English | [中文](README.zh.md)

## Summary

`dsh-web` provides `ctx.web.fetch()` and a registry of fetch providers. It selects one usable provider at call time and reports structured `WebError` failures. The service makes no network requests itself and registers no model-facing tool.

## Use this package

Mount the service with a fetch provider. A single usable provider is selected automatically; configure `fetchProvider` or `DSH_WEB_FETCH_PROVIDER` to choose an id explicitly.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

A provider registers through `ctx.web.registerFetchProvider(provider)`. Call `ctx.web.fetch({ url }, signal)` to retrieve a URL. The result contains the final URL, HTTP status, decoded body, and a truncation flag. A non-2xx response is a result. The optional `AbortSignal` reaches the provider.

## Model Experience

The service contributes no schema or prompt. [`dsh-tool-web`](../tool-web/README.md) exposes its fetch capability to the model.

## Known Limitations and Deferred Work

Without a usable provider, calls fail with `WEB_PROVIDER_UNAVAILABLE`; ambiguous or configured unavailable providers fail with their corresponding `WebError` codes.
