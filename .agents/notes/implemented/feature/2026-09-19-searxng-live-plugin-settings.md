# Agent Note: Live SearXNG Plugin Settings

Status: implemented

English | [中文](2026-09-19-searxng-live-plugin-settings.zh.md)

## Problem

The SearXNG provider accepted composition fields and `SEARXNG_BASE_URL`, but the Web settings page could not edit them. A deployed user therefore saw `web_search` without any product surface for choosing the instance or its default query options, and changing those values required editing deployment configuration and restarting the process.

## Decision

The provider owns a live `web-search-searxng` settings namespace whose base layer is the resolved composition entry, including the environment fallback. It reads that namespace at the start of every search, so an accepted write affects the next request without replacing the provider registration.

The Web **Plugin configuration** tab ships a SearXNG card under the same namespace key. It exposes the provider's complete configurable surface: `baseURL`, `language`, `categories`, and `safesearch`. The card stages edits, validates the endpoint and SafeSearch range before saving, preserves revision-fenced writes, and lets each field return to its deployment value.

The card also exposes **Test connection** for the saved configuration. The Client calls the generated `web/testSearchConnection` Remote operation, and `WebRuntime` executes one cancellable, one-result search through its selected provider. This preserves the same provider selection, concurrency, HTTP validation, JSON decoding, and cancellation path used by model-facing searches. A valid empty result succeeds because connectivity does not depend on result relevance.

## Alternatives considered

**Keep configuration deployment-only.** This leaves an installed search tool unusable from the product screen where users already configure host plugins and was the gap this work needed to close.

**Reload the provider after every settings write.** Search options contain no connection or cached client state. Reading one settings snapshot per request is smaller and avoids a transient missing-provider interval.

**Put a browser bundle in the provider package.** The repository's shipped Plugin configuration cards already share staged form controls and card chrome in `dsh-client-ui-settings-plugins`. Registering this built-in card there avoids duplicating those controls while retaining the namespace join used by the settings tab.

## Consequences

- The Web settings document persists SearXNG overrides and marks them as live.
- `SEARXNG_BASE_URL` remains the inherited base when no user override exists; resetting the URL returns to it.
- The UI lists categories as comma-separated text because available categories depend on the configured SearXNG instance.
- Connection tests use persisted settings and require pending edits to be saved first.
- Focused Host and browser tests cover namespace registration, live request updates, invalid values, all four controls, and slot registration.
