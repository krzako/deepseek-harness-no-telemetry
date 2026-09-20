# @deepseek-ai/dsh-export-conversation-pdf

Persistent DeepSeek Harness Web bundle that exports the current conversation to a
PDF rendered by system Chromium.

**Runtime invariant:** No companion is published because this precompiled UI
adapter owns no durable event stream or mutable state relation.

## Packaging

- shipped as a workspace package and mounted by the built-in `dsh-web-app` composition;
- no bundled `node_modules`, `.deb`, `.so`, Chromium or `LD_LIBRARY_PATH` tricks;
- `puppeteer-core` is a normal npm dependency installed by pnpm;
- Chromium and its Linux libraries are owned by the Docker image / APT;
- environment probe at `/dsh/cordis/export-conversation/status`;
- the Web client shows `alert()` with an installation hint if Chromium or required
  system libraries are missing;
- temporary renderer input files live under the OS temp directory instead of the
  installed package directory;
- download tokens use `crypto.randomBytes`.

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

The Docker deployment installs Chromium and sets the sandbox fallback. No
runtime plugin installation or profile mutation is required.

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

At Web startup the client asks the host for renderer status. If Chromium is absent,
its dynamic libraries are unresolved, or the executable cannot run, the client shows
an `alert()` explaining that Chromium must be installed in the DSH environment.

## Development check

```sh
npm run check
```
