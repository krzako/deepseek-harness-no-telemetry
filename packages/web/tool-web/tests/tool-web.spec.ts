import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'

async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebRuntime)
  ctx.web.registerFetchProvider({
    id: 'fixture', available: () => true,
    fetch: async request => ({
      url: request.url, statusCode: 200,
      body: { kind: 'text', content: 'Fetched page' }, truncated: false,
    }),
  })
  await ctx.plugin(ToolWeb)
  return ctx
}

describe('web fetch tool', () => {
  it('registers only web_fetch and reads a URL', async () => {
    const ctx = await mount()
    const schemas = ctx.tools.schemas().map(schema => schema.name)
    expect(schemas).toContain('web_fetch')
    expect(schemas).not.toContain('web_search')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('fetch-test'), name: 'web_fetch',
      arguments: { url: 'https://example.com' },
    })
    expect(JSON.stringify(result)).toContain('Fetched page')
  })
})
