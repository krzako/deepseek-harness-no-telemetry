# Web Fetch

English | [中文](web.zh.md)

The `ctx.web` service selects a registered fetch provider at call time. [`dsh-web`](../../packages/web/web/README.md) declares the service, [`dsh-web-fetch-http`](../../packages/web/web-fetch-http/README.md) provides public HTTP(S) retrieval, and [`dsh-tool-web`](../../packages/web/tool-web/README.md) exposes `web_fetch` to the model.

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
