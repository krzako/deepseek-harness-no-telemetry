// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { webCardModel } from '../src/client/tool/models/web-card-model.ts'

const fetchResult: ToolResultNode = {
  kind: 'tool-result', seq: 1, time: 1, callId: 'c1',
  call: { name: 'web_fetch', argsRaw: '{"url":"https://example.com"}' },
  callTime: 0, content: [], isError: false, subCalls: [],
  meta: { url: 'https://example.com', statusCode: 200, truncated: false },
}

describe('web fetch card', () => {
  it('renders persisted fetch metadata', () => {
    expect(webCardModel(fetchResult)).toEqual({
      kind: 'fetch', url: 'https://example.com', statusCode: 200, truncated: false,
    })
  })

  it('does not render a card for an invalid URL argument', () => {
    expect(webCardModel({ ...fetchResult, call: { name: 'web_fetch', argsRaw: '{"url":" "}' } })).toBeNull()
  })
})
