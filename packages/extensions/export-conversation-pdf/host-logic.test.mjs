import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHtml,
  conversationPdfFilename,
  conversationStats,
  conversationTitle,
  isWebSearchCallData,
  sanitizedIsoDate,
  surfaceToMessages,
} from './host-logic.mjs'

test('exports web_search request and result while ignoring other tools', () => {
  const events = [
    { type: 'tool/call', time: 1, data: { callId: 'search-1', name: 'web_search', arguments: '{"queries":["latest news"]}' } },
    { type: 'tool/result', time: 2, data: { message: { source: { callId: 'search-1' }, content: [{ type: 'tool-result', toolCallId: 'search-1', isError: false, content: [{ type: 'text', text: 'Sources:\n- [Example](https://example.com)' }] }] } } },
    { type: 'tool/call', time: 3, data: { callId: 'bash-1', name: 'bash', arguments: '{"command":"pwd"}' } },
    { type: 'tool/result', time: 4, data: { message: { source: { callId: 'bash-1' }, content: [{ type: 'tool-result', toolCallId: 'bash-1', isError: false, content: [{ type: 'text', text: '/tmp' }] }] } } },
  ]

  const messages = surfaceToMessages({ events }, false, true)
  assert.deepEqual(messages.map((message) => message.role), ['web-search-call', 'web-search-result'])
  assert.match(messages[0].text, /"latest news"/)
  assert.match(messages[1].text, /https:\/\/example\.com/)

  const html = buildHtml({ title: 'Search', messages, includeThinking: false, includeWebSearch: true })
  assert.match(html, /Web search · zapytanie/)
  assert.match(html, /Web search · wynik/)
  assert.doesNotMatch(html, />\/tmp</)
})

test('marks a failed web_search result', () => {
  const messages = surfaceToMessages({ events: [
    { type: 'tool/call', time: 1, data: { callId: 'search-1', name: 'web_search', arguments: 'not-json' } },
    { type: 'tool/result', time: 2, data: { message: { source: { callId: 'search-1' }, content: [{ type: 'tool-result', toolCallId: 'search-1', isError: true, content: [{ type: 'text', text: 'connection failed' }] }] } } },
  ] }, false, true)

  assert.equal(messages[0].text, 'not-json')
  assert.equal(messages[1].isError, true)
  assert.match(buildHtml({ title: 'Search', messages, includeThinking: false, includeWebSearch: true }), /tool-error">Błąd/)
})

test('exports web_search executed through the PTC run_code wrapper', () => {
  const call = {
    callId: 'code-1',
    name: 'run_code',
    arguments: JSON.stringify({
      code: 'const result = await tools.web_search({\n  queries: ["crispy chicken", "fried chicken"]\n});\nconsole.log(JSON.stringify(result.sources));',
      description: 'Search recipes',
    }),
  }
  assert.equal(isWebSearchCallData(call), true)

  const messages = surfaceToMessages({ events: [
    { type: 'tool/call', time: 1, data: call },
    { type: 'tool/result', time: 2, data: { message: { source: { kind: 'tool', callId: 'code-1' }, content: [{ type: 'tool-result', toolCallId: 'code-1', isError: false, content: [{ type: 'text', text: '[{"url":"https://example.com"}]' }] }] } } },
  ] }, false, true)

  assert.deepEqual(messages.map((message) => message.role), ['web-search-call', 'web-search-result'])
  assert.equal(messages[0].text, '{\n  "queries": [\n    "crispy chicken",\n    "fried chicken"\n  ]\n}')
  assert.match(messages[1].text, /https:\/\/example\.com/)
})

test('web activity is off by default and web_fetch includes only its URL', () => {
  const events = [
    { type: 'tool/call', time: 1, data: { callId: 'fetch-1', name: 'run_code', arguments: JSON.stringify({ code: 'const page = await tools.web_fetch({ url: "https://example.com/article" });\nconsole.log(page.body.content);' }) } },
    { type: 'tool/result', time: 2, data: { message: { source: { callId: 'fetch-1' }, content: [{ type: 'tool-result', toolCallId: 'fetch-1', isError: false, content: [{ type: 'text', text: '<html>secret full page body</html>' }] }] } } },
  ]

  assert.deepEqual(surfaceToMessages({ events }, false), [])
  const messages = surfaceToMessages({ events }, false, true)
  assert.deepEqual(messages, [{ role: 'web-fetch', time: 1, callId: 'fetch-1', url: 'https://example.com/article' }])
  const html = buildHtml({ title: 'Fetch', messages, includeThinking: false, includeWebSearch: true })
  assert.match(html, /Pobieram zawartość/)
  assert.match(html, /href="https:\/\/example\.com\/article"/)
  assert.doesNotMatch(html, /secret full page body/)
})

test('derives filename metadata from the conversation start and title', () => {
  const events = [
    { type: 'session/title', time: 10, data: { title: 'Initial title' } },
    { type: 'user/message', time: Date.parse('2026-09-20T10:44:00.000Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] } },
    { type: 'assistant/message', time: Date.parse('2026-09-20T10:45:00.000Z'), data: { message: { source: { model: 'test' }, content: [{ type: 'text', text: 'Answer' }] } } },
    { type: 'session/title', time: 20, data: { title: 'Crispy chicken recipe' } },
  ]

  assert.equal(conversationTitle(events), 'Crispy chicken recipe')
  assert.deepEqual(conversationStats(events), {
    messageCount: 2,
    startedAt: Date.parse('2026-09-20T10:44:00.000Z'),
  })
  assert.equal(sanitizedIsoDate(Date.parse('2026-09-20T10:44:00.000Z')), '2026-09-20T10-44-00-000Z')
  assert.equal(conversationPdfFilename({
    startedAt: Date.parse('2026-09-20T10:43:30.000Z'),
    title: conversationTitle(events),
    messageCount: 2,
  }), 'dsh_2026-09-20T10-43-30-000Z_crispy-chicken-recipe_2_messages.pdf')
  assert.equal(conversationPdfFilename({
    startedAt: Date.parse('2026-09-20T10:43:30.000Z'),
    title: conversationTitle(events),
    messageCount: 2,
    includeThinking: true,
    includeWebSearch: true,
  }), 'dsh_2026-09-20T10-43-30-000Z_crispy-chicken-recipe+thinking+ws_2_messages.pdf')
  const html = buildHtml({
    title: conversationTitle(events),
    messages: surfaceToMessages({ events }, false, false),
    includeThinking: false,
  })
  assert.match(html, /<h1>Crispy chicken recipe<\/h1>/)
  assert.doesNotMatch(html, /<h1>Rozmowa<\/h1>/)
})
