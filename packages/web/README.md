---
description: "Package map for the web access capability family: search and fetch providers and their model-facing tools."
kind: "package-group"
---

# web/ — web access capability family

English | [中文](README.zh.md)

## Summary

The `web/` group provides search and URL retrieval through `ctx.web`, the SearXNG search provider, the public HTTP(S) fetch provider, and model-facing `web_search` and `web_fetch` tools. Provider selection, cancellation, and errors belong to the service.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The subsystem reference owns the exhaustive vocabulary and contracts.

| Package | Role | ctx key |
|---|---|---|
| [`web/`](web/README.md) | Search and fetch service with separate provider selection | `ctx.web` |
| [`web-search-searxng/`](web-search-searxng/README.md) | Searches a configured SearXNG instance | registers on `ctx.web` |
| [`web-fetch-http/`](web-fetch-http/README.md) | Fetches public HTTP(S) pages anonymously | registers on `ctx.web` |
| [`tool-web/`](tool-web/README.md) | Exposes `web_search` and `web_fetch` to the model | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then the design decision behind the single provider-selection service.

- [Web subsystem](../../docs/subsystems/web.md) — the fetch request and result, provider availability, `WebError`, and public-address enforcement.
- [Web capability seam decision](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — the original web service decision and its removal note.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
