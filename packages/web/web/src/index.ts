/**
 * Service Definition for the web access capability seam (`ctx.web`): registries and provider-selecting execution for search and
 * fetch. Duplicate ids are rejected. At execution time, a configured provider must exist and
 * be usable; without one, exactly one usable provider is required, so selection never depends
 * on registration order.
 * @module @deepseek-ai/dsh-web
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchConnectionTestRequest,
  WebSearchRequest,
  WebSearchResult,
} from './types.ts'
import { WebError } from './types.ts'

export {
  WebError,
} from './types.ts'
export type {
  WebFetchBody,
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchConnectionOption,
  WebSearchConnectionTestRequest,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from './types.ts'

/** Settings namespace for model-facing web-search limits. */
export const WEB_SEARCH_SETTINGS_NAMESPACE = 'web-search'

/** Default maximum combined sources returned by one model-facing search. */
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 12

/** Default maximum queries accepted by one model-facing search call. */
export const DEFAULT_WEB_SEARCH_MAX_QUERIES = 4

/** Default maximum number of provider searches active across the Host. */
export const DEFAULT_WEB_SEARCH_MAX_CONCURRENT = 4

/** Default cooperative model-facing search timeout in milliseconds. */
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 30_000

const searchMaxResultsSchema = z.number().step(1).min(1).default(DEFAULT_WEB_SEARCH_MAX_RESULTS)
const searchMaxQueriesSchema = z.number().step(1).min(1).default(DEFAULT_WEB_SEARCH_MAX_QUERIES)
const searchMaxConcurrentSchema = z.number().step(1).min(1).default(DEFAULT_WEB_SEARCH_MAX_CONCURRENT)
const searchTimeoutMsSchema = z.number().step(1).min(1).max(2_147_483_647).default(DEFAULT_WEB_SEARCH_TIMEOUT_MS)

/** Administrator-owned model-facing search limits. */
export interface WebSearchSettings {
  /** Combined source cap for one tool call. */
  readonly searchMaxResults: number
  /** Query-count cap for one tool call. */
  readonly searchMaxQueries: number
  /** Provider searches allowed to execute concurrently across the Host. */
  readonly searchMaxConcurrent: number
  /** Cooperative tool-call timeout including concurrency-queue wait. */
  readonly searchTimeoutMs: number
}

/** Schema shared by the settings service and the WebRuntime composition config. */
export const WebSearchSettingsSchema: z<WebSearchSettings> = z.object({
  searchMaxResults: searchMaxResultsSchema,
  searchMaxQueries: searchMaxQueriesSchema,
  searchMaxConcurrent: searchMaxConcurrentSchema,
  searchTimeoutMs: searchTimeoutMsSchema,
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection<P> {
  /** The configured provider id for this capability, if any. */
  readonly configuredId?: string
  /** Providers registered for this capability kind. */
  readonly providers: ReadonlyMap<string, P>
}

/**
 * Config for the web seam. `searchProvider` / `fetchProvider` pin which provider
 * wins for each capability; both are optional (a single registered usable
 * provider auto-selects). Operational overrides such as environment variables
 * must feed these same fields rather than introduce a hidden priority chain.
 */
export interface WebRuntimeConfig {
  /** Explicit search provider id. Omitted = auto-select when exactly one usable. */
  readonly searchProvider?: string
  /** Explicit fetch provider id. Omitted = auto-select when exactly one usable. */
  readonly fetchProvider?: string
  /** Combined source cap for one model-facing search call. */
  readonly searchMaxResults?: number
  /** Query-count cap for one model-facing search call. */
  readonly searchMaxQueries?: number
  /** Provider searches allowed to execute concurrently across the Host. */
  readonly searchMaxConcurrent?: number
  /** Cooperative model-facing search timeout in milliseconds. */
  readonly searchTimeoutMs?: number
}

type ResolvedWebRuntimeConfig = WebRuntimeConfig & WebSearchSettings

interface SearchWaiter {
  readonly signal?: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
  readonly onAbort?: () => void
}

/**
 * The web access service. Registered as `ctx.web` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `WEB_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `WEB_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `WEB_PROVIDER_UNAVAILABLE`.
 */
export class WebRuntime extends TypertRemoteService {
  /**
   * Provider selection config. Operational env overrides feed the SAME fields:
   * `$DSH_WEB_SEARCH_PROVIDER` / `$DSH_WEB_FETCH_PROVIDER` are equivalent to
   * `searchProvider` / `fetchProvider` and are NOT a hidden priority chain.
   */
  static Config: z<WebRuntimeConfig> = z.object({
    searchProvider: z.string(),
    fetchProvider: z.string(),
    searchMaxResults: searchMaxResultsSchema,
    searchMaxQueries: searchMaxQueriesSchema,
    searchMaxConcurrent: searchMaxConcurrentSchema,
    searchTimeoutMs: searchTimeoutMsSchema,
  })

  private searchProviders = new Map<string, WebSearchProvider>()
  private fetchProviders = new Map<string, WebFetchProvider>()
  private readonly searchProviderId: string | undefined
  private readonly fetchProviderId: string | undefined
  private searchSettingsSource: () => WebSearchSettings
  private activeSearches = 0
  private readonly searchWaiters: SearchWaiter[] = []
  private searchStopped = false

  constructor(ctx: Context, config: WebRuntimeConfig = {}) {
    super(ctx, 'web', { namespace: 'web' })
    const resolved = config as ResolvedWebRuntimeConfig
    this.searchProviderId = config.searchProvider ?? process.env.DSH_WEB_SEARCH_PROVIDER
    this.fetchProviderId = config.fetchProvider ?? process.env.DSH_WEB_FETCH_PROVIDER
    const entry: WebSearchSettings = {
      searchMaxResults: resolved.searchMaxResults,
      searchMaxQueries: resolved.searchMaxQueries,
      searchMaxConcurrent: resolved.searchMaxConcurrent,
      searchTimeoutMs: resolved.searchTimeoutMs,
    }
    this.searchSettingsSource = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, WEB_SEARCH_SETTINGS_NAMESPACE, WebSearchSettingsSchema, entry, {
        setSource: (current) => { this.searchSettingsSource = current },
        onChange: () => { this.drainSearchQueue() },
      })
    })
    ctx.effect(() => () => { this.stopSearchQueue() }, 'web.searchQueue()')
  }

  /** Current administrator-owned search limits. */
  get searchSettings(): WebSearchSettings {
    return this.searchSettingsSource()
  }

  /**
   * Register a search provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for search. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerSearchProvider(provider: WebSearchProvider): () => void {
    return this.registerProvider(this.searchProviders, provider)
  }

  /**
   * Register a fetch provider. Throws {@link WebError} `WEB_DUPLICATE_PROVIDER`
   * if its id is already registered for fetch. Returns a disposer; disposed
   * with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerFetchProvider(provider: WebFetchProvider): () => void {
    return this.registerProvider(this.fetchProviders, provider)
  }

  private registerProvider<P extends { readonly id: string }>(store: Map<string, P>, provider: P): () => void {
    if (store.has(provider.id)) {
      throw new WebError(`a web provider with id "${provider.id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider)
      yield () => store.delete(provider.id)
    }, 'web.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Run one search through the selected provider. Resolves the provider at call
   * time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. The seam enforces `request.maxResults` on the result:
   * if the provider over-returns, `sources[]` is truncated and `truncated` set.
   * @param request - the query and optional result limit.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the provider's results, capped to `request.maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const release = await this.acquireSearchSlot(signal)
    try {
      const provider = resolveProvider({
        providers: this.searchProviders,
        ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
      })
      const result = await provider.search(request, signal)
      return capSources(result, request.maxResults)
    } finally {
      release()
    }
  }

  /**
   * Verify the selected search provider using transient settings supplied by
   * its configuration form. A valid empty result still means the connection
   * succeeded because the provider checked the HTTP status and response shape.
   * @param request - provider-owned draft option names and values.
   * @param signal - caller lifetime forwarded to the provider request.
   */
  @Remote
  async testSearchConnection(request: WebSearchConnectionTestRequest, signal: AbortSignal): Promise<void> {
    const release = await this.acquireSearchSlot(signal)
    try {
      const provider = resolveRegisteredProvider({
        providers: this.searchProviders,
        ...this.searchProviderId !== undefined ? { configuredId: this.searchProviderId } : {},
      })
      if (provider.testConnection === undefined) {
        throw new WebError(`web search provider "${provider.id}" does not support draft connection tests`, 'WEB_PROVIDER_ERROR')
      }
      await provider.testConnection(request, signal)
    } finally {
      release()
    }
  }

  /** Wait for one Host-wide provider-search slot. */
  private acquireSearchSlot(signal?: AbortSignal): Promise<() => void> {
    if (this.searchStopped) {
      return Promise.reject(new WebError('web search is unavailable because the web runtime is stopping', 'WEB_ABORTED'))
    }
    if (signal?.aborted) {
      return Promise.reject(new WebError('web search aborted while waiting to run', 'WEB_ABORTED', { cause: signal.reason }))
    }
    if (this.activeSearches < this.searchSettings.searchMaxConcurrent) {
      this.activeSearches += 1
      return Promise.resolve(this.searchRelease())
    }
    return new Promise((resolve, reject) => {
      const waiter: SearchWaiter = {
        resolve,
        reject,
        ...signal === undefined ? {} : { signal },
        ...signal === undefined ? {} : {
          onAbort: () => {
            const index = this.searchWaiters.indexOf(waiter)
            if (index !== -1) this.searchWaiters.splice(index, 1)
            reject(new WebError('web search aborted while waiting to run', 'WEB_ABORTED', { cause: signal.reason }))
          },
        },
      }
      signal?.addEventListener('abort', waiter.onAbort as () => void, { once: true })
      this.searchWaiters.push(waiter)
    })
  }

  /** Build an idempotent release callback for one acquired search slot. */
  private searchRelease(): () => void {
    let held = true
    return () => {
      if (!held) return
      held = false
      this.activeSearches -= 1
      this.drainSearchQueue()
    }
  }

  /** Admit queued searches in FIFO order up to the current live limit. */
  private drainSearchQueue(): void {
    if (this.searchStopped) return
    while (this.activeSearches < this.searchSettings.searchMaxConcurrent) {
      const waiter = this.searchWaiters.shift()
      if (waiter === undefined) return
      waiter.signal?.removeEventListener('abort', waiter.onAbort as () => void)
      if (waiter.signal?.aborted) {
        waiter.reject(new WebError('web search aborted while waiting to run', 'WEB_ABORTED', { cause: waiter.signal.reason }))
        continue
      }
      this.activeSearches += 1
      waiter.resolve(this.searchRelease())
    }
  }

  /** Reject queued searches when the owning service stops. */
  private stopSearchQueue(): void {
    this.searchStopped = true
    const error = new WebError('web search is unavailable because the web runtime is stopping', 'WEB_ABORTED')
    for (const waiter of this.searchWaiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort as () => void)
      waiter.reject(error)
    }
  }

  /**
   * Retrieve one URL through the selected provider. Resolves the provider at
   * call time with the selection rules above; throws {@link WebError} when the
   * capability cannot run. A non-2xx response is a result, not a throw.
   * @param request - the URL plus retrieval options.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the retrieval outcome; non-2xx responses resolve descriptively.
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = resolveProvider({
      providers: this.fetchProviders,
      ...this.fetchProviderId !== undefined ? { configuredId: this.fetchProviderId } : {},
    })
    return provider.fetch(request, signal)
  }
}

interface ResolvableProvider {
  readonly id: string
  available(): boolean
}

/** Resolve the selected provider or throw the matching {@link WebError}. */
function resolveProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new WebError(`configured web provider "${configuredId}" is registered but unavailable`, 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new WebError('no usable web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new WebError(`multiple usable web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Resolve a provider for testing before its draft configuration is saved. */
function resolveRegisteredProvider<P extends ResolvableProvider>(selection: Selection<P>): P {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new WebError(`configured web provider "${configuredId}" is not registered`, 'WEB_PROVIDER_CONFIGURED_MISSING')
    }
    return provider
  }
  const registered = [...providers.values()]
  const [single] = registered
  if (single === undefined) {
    throw new WebError('no web provider is registered', 'WEB_PROVIDER_UNAVAILABLE')
  }
  if (registered.length > 1) {
    const ids = registered.map(provider => provider.id).join(', ')
    throw new WebError(`multiple web providers are registered (${ids}); configure one explicitly`, 'WEB_PROVIDER_AMBIGUOUS')
  }
  return single
}

/** Enforce `maxResults` on a search result: truncate `sources[]` and flag it. */
function capSources(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

export default WebRuntime
