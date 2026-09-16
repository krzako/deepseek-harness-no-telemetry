---
description: "The model-facing web_fetch tool over ctx.web."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-web

English | [中文](README.zh.md)

## Summary

`dsh-tool-web` registers `web_fetch` for reading a specific public HTTP(S) URL through `ctx.web`. It marks returned page text as external and untrusted. HTML is converted to Markdown with active and hidden content omitted. The tool remains visible when no fetch provider is available and reports a structured error when called.

## Use this package

Mount `dsh-web`, a fetch provider, and this package:

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-http'
- name: '@deepseek-ai/dsh-tool-web'
```

| Field | Default | Meaning |
|---|---|---|
| `fetchTimeoutMs` | `30000` | Cooperative tool-call timeout in milliseconds |
| `fetchMaxOutputChars` | `200000` | Limit on converted input and complete result text |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-web) lists the supported fields. Call `web_fetch` with `{ url: 'https://example.com' }`. A non-2xx HTTP response remains a result with its status code. The result includes a truncation notice when the provider or output limit cuts the body.

## Model Experience

The model receives `web_fetch` with a required `url` argument and guidance to treat page text as untrusted data and cite the URL. The result includes the final URL, HTTP status, and bounded content.

## Known Limitations and Deferred Work

Only URLs accepted by the mounted fetch provider can be retrieved. The bundled provider rejects private destinations, unsupported content, and unsafe redirects.
