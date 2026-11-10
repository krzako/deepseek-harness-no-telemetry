---
description: "PDF conversation export plugin for deployments and maintainers configuring Chromium, browser routes, and model-triggered exports."
kind: "package-reference"
---

# @deepseek-ai/dsh-export-conversation-pdf

## Summary

This plugin exports the current DeepSeek Harness conversation to a PDF rendered by system Chromium. Users can trigger it from the Web conversation header, and the agent can call `export_conversation_pdf`. The Docker image owns Chromium and its libraries; the package does not bundle a browser. The precompiled UI adapter publishes no runtime invariant companion because it owns no durable event stream or mutable state relation.

## Table of Contents

- [Packaging](#packaging)
- [Docker requirement](#docker-requirement)
- [Runtime behavior](#runtime-behavior)
- [Development check](#development-check)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Packaging

- shipped as a workspace package and mounted by the built-in `dsh-web-app` composition;
- no bundled `node_modules`, `.deb`, `.so`, Chromium or `LD_LIBRARY_PATH` tricks;
- `puppeteer-core` is a normal npm dependency installed by pnpm;
- Chromium and its Linux libraries are owned by the Docker image / APT;
- environment probe at `/dsh/cordis/export-conversation/status`;
- the Web client shows `alert()` with an installation hint if Chromium or required system libraries are missing;
- temporary renderer input files live under the OS temp directory instead of the installed package directory;
- download tokens use `crypto.randomBytes`.
- optionally exports `web_search` requests and their matching results alongside user and assistant messages;
- the same opt-in includes each `web_fetch` URL as a short activity entry while omitting the fetched page body; other tool calls remain omitted.

## Docker requirement

For the usual `node:24-bookworm` image add:

```dockerfile
USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        chromium-sandbox \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

The Docker deployment installs Chromium and sets the sandbox fallback. No runtime plugin installation or profile mutation is required.

## Runtime behavior

The plugin adds:

- a `thinking` checkbox and `PDF` button in the conversation header;
- model tool `export_conversation_pdf({ includeThinking })`;
- `GET /dsh/cordis/export-conversation/status`;
- `GET /dsh/cordis/export-conversation/trigger?...`;
- `GET /dsh/cordis/export-conversation/file?...`.

Browser resolution order:

1. `PUPPETEER_EXECUTABLE_PATH`;
2. `/usr/bin/chromium`;
3. `/usr/bin/chromium-browser`;
4. `/usr/bin/google-chrome-stable`;
5. `/usr/bin/google-chrome`;
6. `/usr/bin/chrome-headless-shell`.

At Web startup the client asks the host for renderer status. If Chromium is absent, its dynamic libraries are unresolved, or the executable cannot run, the client shows an `alert()` explaining that Chromium must be installed in the DSH environment.

## Development check

```sh
npm run check
```

## Model Experience

### Conversation export

#### What the model sees

The model sees the `export_conversation_pdf` function with optional `includeThinking` and `includeWebSearch` Boolean arguments. Its result reports success, a download URL and filename, or an error. The tool description tells the agent to use the function only when the user requests a PDF export.

#### Token effect

The function schema contributes to the model request when the tool is available. Calling it adds the tool call and its result to the conversation; rendering the PDF makes no additional model request.

#### KV Cache effect

The schema remains stable for a loaded plugin. Export options and generated download URLs appear in later conversation history and can alter cache reuse after the changed prefix.

## Known Limitations and Deferred Work

- PDF export requires an executable system Chromium and its shared libraries; the package cannot render a PDF when the deployment lacks them.
- `includeWebSearch` includes search activity and fetched URLs, not fetched page bodies or unrelated tool calls.

### Dev Note

None.
