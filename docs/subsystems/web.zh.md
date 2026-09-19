# 网页搜索与抓取

[English](web.md) | 中文

`ctx.web` 服务在调用时分别选择搜索与抓取提供方。[`dsh-web`](../../packages/web/web/README.zh.md) 声明服务，[`dsh-web-search-searxng`](../../packages/web/web-search-searxng/README.zh.md) 查询已配置的 SearXNG 实例，[`dsh-web-fetch-http`](../../packages/web/web-fetch-http/README.zh.md) 提供公网 HTTP(S) 读取，[`dsh-tool-web`](../../packages/web/tool-web/README.zh.md) 向模型提供 `web_search` 与 `web_fetch`。

`WebSearchRequest` 包含一个查询和可选的结果上限。SearXNG JSON API 提供来源 URL、标题与摘要；服务强制执行结果上限。提供方通过 `baseURL` 或 `SEARXNG_BASE_URL` 设置实例地址，实例必须启用 JSON 输出。`web_search` 提示词明确说明使用 SearXNG，并要求模型将摘要视为不可信数据且引用 URL。

## 搜索类型

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

`WebFetchRequest` 包含一个 `url`。`WebFetchResult` 包含最终 URL、HTTP 状态、解码后的 HTML 或文本正文，以及截断标志。非 2xx 响应仍是结果；不安全目标、不支持的内容和提供方故障抛出 `WebError`。调用方可以向 `ctx.web.fetch(request, signal)` 传入 `AbortSignal`。

配置的 `fetchProvider`（或 `DSH_WEB_FETCH_PROVIDER`）选择一个已注册且可用的 ID。未配置 ID 时，必须恰好有一个可用提供方。提供方注册会返回注销函数，并拒绝重复 ID。

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
