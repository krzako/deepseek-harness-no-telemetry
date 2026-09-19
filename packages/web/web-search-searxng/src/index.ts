/** SearXNG JSON API provider for the `ctx.web` search capability. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { searchURL, SearxngSearchProvider } from './provider.ts'

export { SearxngSearchProvider, SEARXNG_PROVIDER_ID } from './provider.ts'
export type { SearxngOptions, SearxngOptionsSource } from './provider.ts'

export const name = 'web-search-searxng'
export const inject = ['web']

/** User-settings namespace and plugin-configuration card key. */
export const SEARXNG_SETTINGS_NAMESPACE = 'web-search-searxng'

/** The endpoint is deployment-owned; no public SearXNG instance is assumed. */
export interface Config {
  /** Instance root URL, optionally containing a path prefix. */
  baseURL?: string
  /** SearXNG language code. Defaults to `all`. */
  language?: string
  /** Comma-separated SearXNG categories. Omitted uses the instance default. */
  categories?: string
  /** SearXNG safe-search level, 0–2. Omitted uses the instance default. */
  safesearch?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  language: z.string().default('all'),
  categories: z.string(),
  safesearch: z.number().step(1).min(0).max(2),
})

/**
 * Reject an endpoint the provider cannot address.
 * @param config - resolved composition and user settings.
 */
export function assertServiceableSearxngConfig(config: Config): void {
  if (config.baseURL !== undefined) searchURL(config.baseURL, 'configuration-check', config)
}

export function apply(ctx: Context, config: Config): void {
  const environmentBaseURL = launchEnvironmentOf(ctx).get('SEARXNG_BASE_URL')?.value
  const entry: Config = {
    ...config.baseURL !== undefined
      ? { baseURL: config.baseURL }
      : environmentBaseURL !== undefined ? { baseURL: environmentBaseURL } : {},
    ...config.language !== undefined ? { language: config.language } : {},
    ...config.categories !== undefined ? { categories: config.categories } : {},
    ...config.safesearch !== undefined ? { safesearch: config.safesearch } : {},
  }
  assertServiceableSearxngConfig(entry)
  let source = () => entry
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SEARXNG_SETTINGS_NAMESPACE, Config, entry, {
      validate: assertServiceableSearxngConfig,
      setSource: (current) => { source = current },
      // The provider reads the source for every request, so no derived state needs rebuilding.
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new SearxngSearchProvider(() => source()))
}
