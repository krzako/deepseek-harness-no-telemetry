# Web Search and Fetch

English | [中文](web.zh.md)

The `ctx.web` service selects search and fetch providers at call time. [`dsh-web`](../../packages/web/web/README.md) declares the service, [`dsh-web-search-searxng`](../../packages/web/web-search-searxng/README.md) queries a configured SearXNG instance, [`dsh-web-fetch-http`](../../packages/web/web-fetch-http/README.md) provides public HTTP(S) retrieval, and [`dsh-tool-web`](../../packages/web/tool-web/README.md) exposes `web_search` and `web_fetch` to the model.

`WebSearchRequest` contains one query and an optional result cap. SearXNG's JSON API supplies source URLs, titles, and snippets; the service enforces the result cap. The provider uses `baseURL` or `SEARXNG_BASE_URL` and requires the instance to enable JSON output. The `web_search` prompt identifies SearXNG and tells the model to treat snippets as untrusted data and cite URLs.

## Search types

```ts type-equiv
/**
 * What one search-capable backend is asked to search. Each request carries one
 * query; a consumer may issue several requests. `maxResults` is a
 * `dsh-tool-web`-layer bound passed through unchanged and enforced on the way
 * back by the seam (see {@link WebSearchResult}).
 */
interface WebSearchRequest {
  readonly query: string
  /**
   * Upper bound on returned sources; the seam truncates to it. Omitted = no
   * bound. `dsh-tool-web` always sets it. A provider may use an API-level
   * count limit as an optimization; the seam enforces the bound regardless.
   */
  readonly maxResults?: number
}
```

```ts type-equiv
/**
 * Normalized search outcome. `content` is an optional provider-generated
 * answer or summary; the SearXNG provider returns sources without one.
 * `sources[]` is the portable citation shape. `truncated` is set by the seam
 * when it cut `sources[]` down to `maxResults`.
 */
interface WebSearchResult {
  /** Optional provider-generated answer text, search context, or summary. */
  readonly content?: string
  /** Citeable sources, already truncated to the request's `maxResults`. */
  readonly sources: readonly WebSearchSource[]
  /** True when the seam dropped sources to honor `maxResults`. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * One citeable source. A source always has a URL; `title`, `snippet`, and
 * `publishedAt` are optional because not every provider returns them — forcing
 * adapters to invent them would make the seam lie. `dsh-tool-web` renders
 * `title ?? hostname(url)` for display.
 */
interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string. */
  readonly publishedAt?: string
}
```

```ts type-equiv
/**
 * A search-capable backend. Registered with `ctx.web.registerSearchProvider`.
 * `id` is a stable string, unique within the search capability kind.
 */
interface WebSearchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one search; honor `signal` for cancellation. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}
```

`WebFetchRequest` contains one `url`. `WebFetchResult` contains the final URL, HTTP status, decoded HTML or text body, and a truncation flag. A non-2xx response is a result; unsafe destinations, unsupported content, and provider failures raise `WebError`. Callers may pass an `AbortSignal` to `ctx.web.fetch(request, signal)`.

A configured `fetchProvider` (or `DSH_WEB_FETCH_PROVIDER`) selects one registered, usable id. Without a configured id, exactly one usable provider is required. Provider registration returns a disposer and rejects duplicate ids.

## Fetch types

```ts type-equiv
/**
 * What one fetch-capable backend is asked to retrieve. The request deliberately
 * omits timeout, format, prompt, and extraction controls: cancellation is a
 * direct execution argument, while presentation and higher-level LLM concerns
 * belong outside safe retrieval.
 */
interface WebFetchRequest {
  readonly url: string
}
```

```ts type-equiv
/**
 * Normalized fetch outcome. A successful network fetch of a non-2xx response is
 * a result, not an error: the status code is part of the fetched resource
 * state. {@link WebError} is reserved for failures to safely retrieve or
 * represent the resource.
 */
interface WebFetchResult {
  /** The final URL after allowed redirects (the request URL is in the request). */
  readonly url: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** Decoded body, classified by content kind. */
  readonly body: WebFetchBody
  /** True when the provider capped the decoded body. */
  readonly truncated: boolean
}
```

```ts type-equiv
/**
 * The decoded body of a fetched resource. A CLOSED discriminated union owned by
 * `dsh-web`: the provider decodes the kind and `dsh-tool-web` renders it, so a
 * new kind is a coordinated change across known packages, not a plugin
 * extension. Consumers `switch` on `kind` ending in `default: assertNever(...)`
 * so adding a kind breaks compilation at every consumer until handled. Each arm
 * stays its own object literal even where fields coincide, so an arm can gain
 * fields the others lack.
 */
type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }
```
