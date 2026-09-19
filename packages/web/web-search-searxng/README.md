# SearXNG search provider

English | [中文](README.zh.md)

This plugin registers `searxng` as a search provider on `ctx.web`. The model-facing `web_search` tool calls it through the web service. It uses SearXNG's `/search?q=…&format=json` API and returns source URLs, titles, snippets, and publication dates when present. It returns provider results without generating an answer.

Configure `baseURL` on the `web-search-searxng` Cordis row, or set `SEARXNG_BASE_URL` in the launch environment. The address is the instance root, including any path prefix. For example:

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: http://localhost:8080
    language: pl
    categories: general
    safesearch: 1
```

The provider registers the live `web-search-searxng` settings namespace. In the Web app, open **Settings → Plugins → Plugin configuration → SearXNG** to override the instance URL, language, comma-separated categories, and SafeSearch level. The language defaults to `all` and is sent explicitly on every request. Saves apply to the next search and persist in `$DSH_HOME/settings.yaml`; resetting a field returns it to the composition, environment, or schema default.

Use **Test connection** after saving to send a one-result sample search through the same Host provider path used by the agent. A valid empty JSON result is reported as connected; an HTTP, transport, or JSON decoding failure is reported as failed.

Result count, query count, Host-wide concurrency, and search timeout belong to the adjacent **Web Search** card. They are intentionally absent from the model-facing arguments.

SearXNG must enable `json` in `search.formats`; otherwise its API returns HTTP 403. The provider does not follow redirects, limits a response to 5 MB, and respects tool cancellation. Search results are external untrusted content. `web_search` caps what reaches the model and asks it to cite the returned URLs.

## Model Experience

Indirectly, through `dsh-tool-web`, which renders this provider's source URLs and snippets in the `web_search` tool result.

#### KV Cache effect

A changed search result changes retained tool output; changing provider settings alone does not invalidate an existing request prefix.

## Known Limitations and Deferred Work

The provider reads one SearXNG results page. Engines and instances vary in coverage, and the JSON API must be enabled by the instance administrator.
