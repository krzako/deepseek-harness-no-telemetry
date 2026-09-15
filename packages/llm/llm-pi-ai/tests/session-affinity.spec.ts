import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

// The affinity headers are transport metadata: this spec asserts the real HTTP
// wire (the mock server records every received header), not an intermediate
// options object, and it pins behavior for the session id the loop stamps —
// stable within one conversation, distinct across conversations, absent when
// the request carries none.

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const KEY_ENV = 'PI_TEST_KEY'

/** A complete hand-declared completions route, with the switches under test. */
function profile(baseURL: string, overrides: Record<string, unknown> = {}): LlmPiAi.Config {
  return {
    providers: {
      'acme-gateway': {
        apiKeyEnv: KEY_ENV,
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        baseURL,
        models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 65_536, maxTokens: 4096 }],
        ...overrides,
      },
    },
  }
}

async function harness(config: LlmPiAi.Config): Promise<Context> {
  vi.stubEnv(KEY_ENV, 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

async function stream(ctx: Context, sessionId: string | undefined): Promise<void> {
  await assemble(ctx, {
    provider: 'acme-gateway',
    model: 'acme-large',
    messages: [],
    ...sessionId === undefined ? {} : { sessionId: sessionId as never },
  })
}

describe('session affinity headers', () => {
  it('keeps one session on one id across its requests', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await harness(profile(server.url, {
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
    }))
    await stream(ctx, 'session-AAA')
    await stream(ctx, 'session-AAA')
    expect(server.headers[0]?.['x-session-id']).toBe('session-AAA')
    expect(server.headers[1]?.['x-session-id']).toBe('session-AAA')
  })

  it('separates two sessions by their ids', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await harness(profile(server.url, {
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
    }))
    await stream(ctx, 'session-AAA')
    await stream(ctx, 'session-BBB')
    expect(server.headers[0]?.['x-session-id']).toBe('session-AAA')
    expect(server.headers[1]?.['x-session-id']).toBe('session-BBB')
  })

  it('pins the openai format spellings', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(profile(server.url, {
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openai' },
    }))
    await stream(ctx, 'session-AAA')
    expect(server.headers[0]?.['session_id']).toBe('session-AAA')
    expect(server.headers[0]?.['x-client-request-id']).toBe('session-AAA')
    expect(server.headers[0]?.['x-session-affinity']).toBe('session-AAA')
    expect(server.headers[0]?.['x-session-id']).toBeUndefined()
  })

  it('sends no affinity header when the request carries no session id', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(profile(server.url, {
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
    }))
    await stream(ctx, undefined)
    expect(server.headers[0]?.['x-session-id']).toBeUndefined()
    expect(server.requests[0]).not.toHaveProperty('prompt_cache_key')
  })

  it('sends no affinity header when the profile disables cache retention', async () => {
    // pi-ai treats the session id as prompt-cache state, so a cacheRetention
    // of none drops it before the affinity headers are built. This is the
    // documented coupling, pinned here so a pi-ai upgrade cannot change it
    // silently.
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(profile(server.url, {
      cacheRetention: 'none',
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
    }))
    await stream(ctx, 'session-AAA')
    expect(server.headers[0]?.['x-session-id']).toBeUndefined()
  })

  it('lets an explicit profile header win the collision', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(profile(server.url, {
      headers: { 'x-session-id': 'static-id' },
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
    }))
    await stream(ctx, 'session-AAA')
    expect(server.headers[0]?.['x-session-id']).toBe('static-id')
  })

  it('leaves a provider that did not opt in untouched', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(profile(server.url))
    await stream(ctx, 'session-AAA')
    expect(server.headers[0]?.['x-session-id']).toBeUndefined()
    expect(server.headers[0]?.['x-client-request-id']).toBeUndefined()
    expect(server.headers[0]?.['x-session-affinity']).toBeUndefined()
  })
})
