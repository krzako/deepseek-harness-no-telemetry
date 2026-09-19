import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as Searxng from '../src/index.ts'
import { SearxngSearchProvider, mapSearxngResponse, searchURL } from '../src/provider.ts'

afterEach(() => vi.unstubAllGlobals())

/** Writable in-memory settings provider for the live-configuration integration. */
class MemorySettings extends SettingsProvider {
  private stored: Record<string, unknown> = {}
  override get writable(): boolean { return true }
  protected override load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.stored)) }
  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored = { ...this.stored, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('SearXNG search provider', () => {
  it('builds the JSON API request under a configured path prefix', () => {
    const url = searchURL('http://localhost:8080/searxng/', 'żółw & ocean', {
      language: 'pl-PL', categories: 'general,news', safesearch: 1,
    })
    expect(url.pathname).toBe('/searxng/search')
    expect(url.searchParams.get('q')).toBe('żółw & ocean')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('language')).toBe('pl-PL')
    expect(url.searchParams.get('categories')).toBe('general,news')
    expect(url.searchParams.get('safesearch')).toBe('1')
  })

  it('maps citeable results and drops non-HTTP URLs', () => {
    expect(mapSearxngResponse({ results: [
      { url: 'https://example.org/a', title: 'A', content: 'A snippet', publishedDate: '2026-09-17T00:00:00Z' },
      { url: 'javascript:alert(1)', title: 'Unsafe' },
      { url: 'https://example.org/b', content: '' },
    ] })).toEqual({ sources: [
      { url: 'https://example.org/a', title: 'A', snippet: 'A snippet', publishedAt: '2026-09-17T00:00:00Z' },
      { url: 'https://example.org/b' },
    ], truncated: false })
  })

  it('passes cancellation, rejects redirects, and reports JSON-disabled instances', async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      expect(init.signal).toBe(signal)
      return new Response('', { status: 403 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const provider = new SearxngSearchProvider({ baseURL: 'http://localhost:8080' })
    await expect(provider.search({ query: 'test', maxResults: 3 }, signal))
      .rejects.toThrow('enable JSON')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tests transient form options without reading the saved configuration', async () => {
    const fetchMock = vi.fn(async (_url: URL) => Response.json({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new SearxngSearchProvider({ baseURL: 'http://saved.test', language: 'pl' })

    await provider.testConnection({ options: [
      { name: 'baseURL', value: 'https://draft.test/prefix' },
      { name: 'language', value: 'all' },
      { name: 'categories', value: 'general,news' },
      { name: 'safesearch', value: '2' },
    ] })

    const url = fetchMock.mock.calls[0]?.[0] as URL
    expect(url.origin + url.pathname).toBe('https://draft.test/prefix/search')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: 'SearXNG connection test', format: 'json', language: 'all', categories: 'general,news', safesearch: '2',
    })
  })

  it('is unavailable without an endpoint and rejects malformed envelopes', () => {
    expect(new SearxngSearchProvider({}).available()).toBe(false)
    expect(new SearxngSearchProvider({ baseURL: 'ftp://example.org' }).available()).toBe(false)
    expect(() => mapSearxngResponse({ results: null })).toThrow('invalid JSON')
    expect(() => searchURL('not a URL', 'test', {})).toThrow('valid URL')
  })

  it('registers in ctx.web and searches through configured baseURL', async () => {
    const fetchMock = vi.fn(async (_url: URL) => Response.json({ results: [
      { url: 'https://example.org/recipe', title: 'Recipe', content: 'Chicken and vegetables' },
    ] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'searxng' })
    const fiber = await ctx.plugin(Searxng, { baseURL: 'http://localhost:8080' })
    expect(await ctx.web.search({ query: 'chicken recipe', maxResults: 1 })).toEqual({
      sources: [{ url: 'https://example.org/recipe', title: 'Recipe', snippet: 'Chicken and vegetables' }],
      truncated: false,
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('q=chicken+recipe')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('language=all')
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'chicken recipe' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
  })

  it('serves every option through settings and applies updates to the next search', async () => {
    const fetchMock = vi.fn(async (_url: URL) => Response.json({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'searxng' })
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Searxng, { baseURL: 'http://initial.test', language: 'pl-PL' })

    expect(ctx.settings.describe().find(row => String(row.ns) === Searxng.SEARXNG_SETTINGS_NAMESPACE))
      .toMatchObject({
        value: { baseURL: 'http://initial.test', language: 'pl-PL' },
        applies: 'live',
      })

    await ctx.settings.update(Searxng.SEARXNG_SETTINGS_NAMESPACE, {
      baseURL: 'https://search.example/prefix',
      language: 'en-US',
      categories: 'general,news',
      safesearch: 2,
    })
    await ctx.web.search({ query: 'current information' })

    const url = fetchMock.mock.calls[0]?.[0] as URL
    expect(url.origin + url.pathname).toBe('https://search.example/prefix/search')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: 'current information', format: 'json', language: 'en-US', categories: 'general,news', safesearch: '2',
    })
    await ctx.fiber.dispose()
  })

  it('refuses invalid settings without replacing the working endpoint', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'searxng' })
    await ctx.plugin(MemorySettings)
    await ctx.plugin(Searxng, { baseURL: 'http://initial.test' })

    await expect(ctx.settings.update(Searxng.SEARXNG_SETTINGS_NAMESPACE, { baseURL: 'ftp://invalid.test' }))
      .rejects.toThrow('HTTP(S)')
    expect(ctx.settings.describe().find(row => String(row.ns) === Searxng.SEARXNG_SETTINGS_NAMESPACE)?.value)
      .toMatchObject({ baseURL: 'http://initial.test' })
    await ctx.fiber.dispose()
  })
})
