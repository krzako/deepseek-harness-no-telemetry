---
description: "Package map for the web access capability family: the fetch service, its provider backend, and the model-facing tool that consumes it."
kind: "package-group"
---

# web/ — web access capability family

English | [中文](README.zh.md)

## Summary

The `web/` group provides URL retrieval through `ctx.web`, the public HTTP(S) fetch provider, and the model-facing `web_fetch` tool. Provider selection, cancellation, and errors belong to the service.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Six packages play the web roles; the subsystem reference owns the exhaustive vocabulary and contracts.

| Package | Role | ctx key |
|---|---|---|
| [`web/`](web/README.md) | Fetch service: retrieve URLs through interchangeable backends, one selection and error policy | `ctx.web` |
| [`web-fetch-http/`](web-fetch-http/README.md) | Fetches public HTTP(S) pages anonymously | registers on `ctx.web` |
| [`tool-web/`](tool-web/README.md) | Exposes `web_fetch` to the model | registers on `ctx.tools` |

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
