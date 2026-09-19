import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchConnectionTestRequest, WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable provider id selected by the web service. */
export const SEARXNG_PROVIDER_ID = 'searxng'
const MAX_RESPONSE_BYTES = 5_000_000

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new WebError('SearXNG returned an empty response', 'WEB_PROVIDER_ERROR')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new WebError('SearXNG response exceeds 5 MB', 'WEB_PROVIDER_ERROR')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

/** SearXNG endpoint and optional query defaults. */
export interface SearxngOptions {
  readonly baseURL?: string
  readonly language?: string
  readonly categories?: string
  readonly safesearch?: number
}

/** Static options or a live settings-backed reader. */
export type SearxngOptionsSource = SearxngOptions | (() => SearxngOptions)

/**
 * Resolve an instance root to the documented `/search?format=json` endpoint.
 * @param baseURL - configured SearXNG instance root.
 * @param query - search query.
 * @param options - optional query defaults.
 * @returns the validated JSON search endpoint URL.
 */
export function searchURL(baseURL: string, query: string, options: SearxngOptions): URL {
  let base: URL
  try {
    base = new URL(baseURL)
  } catch (error) {
    throw new WebError('SearXNG baseURL must be a valid URL', 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new WebError('SearXNG baseURL must be an HTTP(S) instance root without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
  }
  const url = new URL(base.toString())
  url.pathname = `${url.pathname.replace(/\/$/, '')}/search`
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  if (options.language) url.searchParams.set('language', options.language)
  if (options.categories) url.searchParams.set('categories', options.categories)
  if (options.safesearch !== undefined) url.searchParams.set('safesearch', String(options.safesearch))
  return url
}

/**
 * Map only citeable HTTP(S) results; SearXNG's `content` is a snippet.
 * @param value - decoded SearXNG JSON response.
 * @returns normalized web search sources.
 */
export function mapSearxngResponse(value: unknown): WebSearchResult {
  if (!value || typeof value !== 'object' || !('results' in value) || !Array.isArray(value.results)) {
    throw new WebError('SearXNG returned an invalid JSON result', 'WEB_PROVIDER_ERROR')
  }
  const sources: WebSearchSource[] = []
  const results: unknown[] = value.results
  for (const entry of results) {
    if (!entry || typeof entry !== 'object' || !('url' in entry) || typeof entry.url !== 'string') continue
    let url: URL
    try { url = new URL(entry.url) } catch { continue }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const title = 'title' in entry ? entry.title : undefined
    const content = 'content' in entry ? entry.content : undefined
    const publishedDate = 'publishedDate' in entry ? entry.publishedDate : undefined
    sources.push({
      url: url.toString(),
      ...typeof title === 'string' && title ? { title } : {},
      ...typeof content === 'string' && content ? { snippet: content } : {},
      ...typeof publishedDate === 'string' && publishedDate ? { publishedAt: publishedDate } : {},
    })
  }
  return { sources, truncated: false }
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Search provider backed by a static or live settings-backed SearXNG configuration. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID
  constructor(private readonly source: SearxngOptionsSource) {}

  /** Read one coherent option snapshot for an availability check or request. */
  private options(): SearxngOptions {
    return typeof this.source === 'function' ? this.source() : this.source
  }

  available(): boolean {
    const options = this.options()
    if (!options.baseURL) return false
    try { searchURL(options.baseURL, 'check', options); return true } catch { return false }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.options()
    if (!options.baseURL) throw new WebError('SearXNG baseURL is not configured', 'WEB_PROVIDER_UNAVAILABLE')
    const url = searchURL(options.baseURL, request.query, options)
    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        ...signal ? { signal } : {},
      })
    } catch (error) {
      if (aborted(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      await response.body?.cancel()
      const hint = response.status === 403 ? '; enable JSON in the SearXNG search.formats setting' : ''
      throw new WebError(`SearXNG returned HTTP ${response.status}${hint}`, 'WEB_PROVIDER_ERROR')
    }
    try {
      return mapSearxngResponse(await readBoundedJson(response))
    } catch (error) {
      if (error instanceof WebError) throw error
      if (aborted(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned invalid JSON: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /** Test draft card values without mutating the live settings source. */
  async testConnection(request: WebSearchConnectionTestRequest, signal?: AbortSignal): Promise<void> {
    const options: Record<string, string> = {}
    for (const option of request.options) {
      if (!['baseURL', 'language', 'categories', 'safesearch'].includes(option.name) || option.name in options) {
        throw new WebError(`unsupported or repeated SearXNG test option: ${option.name}`, 'WEB_PROVIDER_ERROR')
      }
      options[option.name] = option.value
    }
    const safesearch = options.safesearch === undefined ? undefined : Number(options.safesearch)
    if (safesearch !== undefined && (!Number.isInteger(safesearch) || safesearch < 0 || safesearch > 2)) {
      throw new WebError('SearXNG safesearch must be 0, 1, or 2', 'WEB_PROVIDER_ERROR')
    }
    const draft: SearxngOptions = {
      ...options.baseURL === undefined ? {} : { baseURL: options.baseURL },
      ...options.language === undefined ? {} : { language: options.language },
      ...options.categories === undefined ? {} : { categories: options.categories },
      ...safesearch === undefined ? {} : { safesearch },
    }
    await new SearxngSearchProvider(draft).search({ query: 'SearXNG connection test', maxResults: 1 }, signal)
  }
}
