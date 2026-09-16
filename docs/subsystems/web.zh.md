# 网页抓取

[English](web.md) | 中文

`ctx.web` 服务在调用时选择已注册的抓取提供方。[`dsh-web`](../../packages/web/web/README.zh.md) 声明服务，[`dsh-web-fetch-http`](../../packages/web/web-fetch-http/README.zh.md) 提供公网 HTTP(S) 读取，[`dsh-tool-web`](../../packages/web/tool-web/README.zh.md) 向模型提供 `web_fetch`。

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
