import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'

describe('web fetch runtime', () => {
  it('selects the registered provider and retrieves a URL', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    ctx.web.registerFetchProvider({ id: 'http', available: () => true, fetch: async request => ({
      url: request.url, statusCode: 200, body: { kind: 'text', content: 'ok' }, truncated: false,
    }) })
    await expect(ctx.web.fetch({ url: 'https://example.com' })).resolves.toMatchObject({ statusCode: 200 })
  })

  it('reports an unavailable provider', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime)
    await expect(ctx.web.fetch({ url: 'https://example.com' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('keeps error codes', () => {
    expect(new WebError('invalid', 'WEB_INVALID_URL').code).toBe('WEB_INVALID_URL')
  })
})
