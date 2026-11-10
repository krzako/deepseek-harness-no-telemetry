import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
import { CodexModelGateway, codexGatewayModels, type CodexGatewayAuditWriter, type CodexGatewayRequestAuthorizer } from '../src/model-gateway.ts'
import type { CodexGatewayAuditEntry, CodexGatewayRequestBinding, CodexModelGatewayConfig } from '../src/model-gateway.ts'

const authorize: CodexGatewayRequestAuthorizer = metadata => metadata.threadId === 'thread-1'
  && metadata.turnId === 'turn-1' ? { dshSessionId: 'dsh-session-1', dshTurn: 1 } : undefined
const audit: CodexGatewayAuditWriter = async () => {}

function codexTurnMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 'codex-session-1', thread_id: 'thread-1', turn_id: 'turn-1', request_kind: 'turn', ...overrides })
}

const servers: Server[] = []
const gateways: CodexModelGateway[] = []
const logRoots: string[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })))
  await Promise.all(logRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(kind: 'chat' | 'chat-tool' | 'chat-parallel' | 'chat-length' | 'chat-truncated' | 'chat-error' | 'responses'): Promise<{
  baseURL: string
  paths: string[]
  bodies: Record<string, unknown>[]
  rawBodies: string[]
  headers: Array<Record<string, string | string[] | undefined>>
}> {
  const paths: string[] = []
  const bodies: Record<string, unknown>[] = []
  const rawBodies: string[] = []
  const headers: Array<Record<string, string | string[] | undefined>> = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { raw += chunk })
    request.on('end', () => {
      paths.push(request.url ?? '')
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      rawBodies.push(raw)
      headers.push(request.headers)
      if (kind === 'chat-error') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'fixture rate limit' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (kind === 'chat') {
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"chat-ok"},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n')
      } else if (kind === 'chat-tool') {
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_from_chat","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n')
      } else if (kind === 'chat-parallel') {
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"lookup","arguments":"{\\"a\\":"}},{"index":1,"id":"call_b","type":"function","function":{"name":"lookup","arguments":"{\\"b\\":"}}]},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}},{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":3}}}\n\n')
      } else if (kind === 'chat-length') {
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"truncated"},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n')
      } else if (kind === 'chat-truncated') {
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"unfinished"},"finish_reason":null}]}\n\n')
        response.end()
        return
      } else {
        const part = { type: 'output_text', annotations: [], logprobs: [], text: 'responses-ok' }
        const item = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [part] }
        response.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })}\n\n`)
        response.write(`data: ${JSON.stringify({ type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { ...part, text: '' } })}\n\n`)
        response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'responses-ok', logprobs: [] })}\n\n`)
        response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`)
        response.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } })}\n\n`)
      }
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture has no port')
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, paths, bodies, rawBodies, headers }
}

async function call(
  gateway: CodexModelGateway, body: Record<string, unknown>, token: string = gateway.token,
  metadata: string | null = codexTurnMetadata(),
  attemptId: string = randomUUID(),
): Promise<Response> {
  return fetch(`${await gateway.ready}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-dsh-model-attempt-id': attemptId,
      ...metadata === null ? {} : { 'x-codex-turn-metadata': metadata },
    },
    body: JSON.stringify(body),
  })
}

describe('CodexModelGateway', () => {
  it('keeps an admitted attempt on its settings snapshot and routes the next attempt with the new profile', async () => {
    const previous = await fixture('responses')
    const next = await fixture('chat')
    let config: CodexModelGatewayConfig = { providers: { local: {
      apiFormat: 'responses', baseURL: previous.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'model' }],
    } } }
    const held = Promise.withResolvers<undefined>()
    const reached = Promise.withResolvers<undefined>()
    let requests = 0
    const routes: unknown[] = []
    const gateway = new CodexModelGateway(new Context(), () => config, authorize, async (_binding, entry) => {
      if (entry.phase !== 'upstream-request') return
      routes.push((entry.payload as { route: unknown }).route)
      if (++requests !== 1) return
      reached.resolve(undefined)
      await held.promise
    }, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const body = { model: 'local/model', input: [], stream: true }
    const first = call(gateway, body)
    await reached.promise
    config = { providers: { local: {
      baseURL: next.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'model' }],
    } } }
    held.resolve(undefined)
    const firstResponse = await first
    expect(firstResponse.status).toBe(200)
    await firstResponse.text()
    const secondResponse = await call(gateway, body)
    expect(secondResponse.status).toBe(200)
    await secondResponse.text()
    expect(previous.paths).toEqual(['/v1/responses'])
    expect(next.paths).toEqual(['/v1/chat/completions'])
    expect(routes).toEqual([
      { provider: 'local', model: 'model', apiFormat: 'responses' },
      { provider: 'local', model: 'model', apiFormat: 'chat-completions' },
    ])
  })

  it('translates declared Responses image input to ordered Chat image_url parts', async () => {
    const upstream = await fixture('chat')
    const config: CodexModelGatewayConfig = { providers: { vision: {
      apiKeyEnv: 'FIXTURE_API_KEY', baseURL: upstream.baseURL,
      models: [{ id: 'vision-model', input: ['text', 'image'] }],
    } } }
    expect(codexGatewayModels(config)[0]?.inputModalities).toEqual(['text', 'image'])
    const gateway = new CodexModelGateway(new Context(), () => config, authorize, audit,
      { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const image = 'data:image/png;base64,iVBORw0KGgo='
    const response = await call(gateway, { model: 'vision/vision-model', stream: true,
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Describe this:' },
        { type: 'input_image', image_url: image, detail: 'high' },
        { type: 'input_text', text: ' in one sentence.' },
      ] }],
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('chat-ok')
    expect(upstream.bodies[0]?.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'Describe this:' },
      { type: 'image_url', image_url: { url: image, detail: 'high' } },
      { type: 'text', text: ' in one sentence.' },
    ] }])
    const fileId = await call(gateway, { model: 'vision/vision-model', stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }],
    })
    expect(fileId.status).toBe(400)
    expect(await fileId.text()).toContain('image requires an HTTP(S) or base64 data URL')
    expect(upstream.paths).toEqual(['/v1/chat/completions'])
  })

  it('rejects image input for a text-only model and unknown modalities without dispatch', async () => {
    const upstream = await fixture('chat')
    const config: CodexModelGatewayConfig = { providers: { local: {
      apiKeyEnv: 'FIXTURE_API_KEY', baseURL: upstream.baseURL, models: [{ id: 'chat-model', input: ['text'] }],
    } } }
    expect(codexGatewayModels(config)[0]?.inputModalities).toEqual(['text'])
    const gateway = new CodexModelGateway(new Context(), () => config, authorize, audit,
      { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const image = await call(gateway, { model: 'local/chat-model', stream: true,
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
      ] }],
    })
    expect(image.status).toBe(400)
    expect(await image.text()).toContain('does not declare image input')
    const audio = await call(gateway, { model: 'local/chat-model', stream: true,
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } },
      ] }],
    })
    expect(audio.status).toBe(400)
    expect(await audio.text()).toContain('does not support content part')
    expect(upstream.paths).toEqual([])
  })

  it('passes an image through native Responses only for a declared vision model', async () => {
    const upstream = await fixture('responses')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: { native: {
      apiFormat: 'responses', baseURL: upstream.baseURL,
      models: [{ id: 'vision-model', input: ['text', 'image'] }],
    } } }), authorize, audit)
    gateways.push(gateway)
    const input = [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'What is here?' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' },
    ] }]
    const response = await call(gateway, { model: 'native/vision-model', input, stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('responses-ok')
    expect(upstream.bodies[0]?.input).toEqual(input)
  })
  it('records the original request, exact translated payload, response bytes, and usage before completion', async () => {
    const upstream = await fixture('chat')
    const records: Array<{ binding: CodexGatewayRequestBinding; entry: CodexGatewayAuditEntry }> = []
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: { baseURL: upstream.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'chat-model' }] },
    } }), authorize, async (binding, entry) => { records.push({ binding, entry }) }, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const body = { model: 'local/chat-model', input: [{ type: 'message', role: 'user', content: 'audit me' }],
      parallel_tool_calls: false, stream: true }
    const response = await call(gateway, body)
    expect(response.status).toBe(200)
    const output = await response.text()
    expect(output).toContain('chat-ok')
    expect(output).toContain('"parallel_tool_calls":false')
    expect(records[0]?.entry.phase).toBe('original-request')
    expect(records[1]?.entry.phase).toBe('upstream-request')
    expect(records[2]?.entry.phase).toBe('upstream-response')
    expect(records.at(-2)?.entry.phase).toBe('upstream-end')
    expect(records.at(-1)?.entry.phase).toBe('result')
    expect(records.every(record => record.binding.attemptId === records[0]?.binding.attemptId)).toBe(true)
    const original = records[0]?.entry.payload as { rawBody: string }
    expect(JSON.parse(original.rawBody)).toEqual(body)
    const translated = records[1]?.entry.payload as { rawBody: string; url: string; route: unknown }
    expect(translated.url).toBe(`${upstream.baseURL}/chat/completions`)
    expect(translated.route).toEqual({ provider: 'local', model: 'chat-model', apiFormat: 'chat-completions' })
    expect(JSON.parse(translated.rawBody)).toEqual(upstream.bodies[0])
    expect(upstream.bodies[0]?.parallel_tool_calls).toBe(false)
    const chunks = records.filter(record => record.entry.phase === 'upstream-chunk')
      .map(record => Buffer.from((record.entry.payload as { base64: string }).base64, 'base64').toString('utf8'))
    expect(chunks.join('')).toContain('"total_tokens":4')
    expect(records.at(-1)?.entry.payload).toMatchObject({
      type: 'response.completed', response: { usage: { total_tokens: 4 } },
    })
  })

  it('stops before upstream dispatch when durable audit fails', async () => {
    const upstream = await fixture('responses')
    let writes = 0
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: { baseURL: upstream.baseURL, apiFormat: 'responses', models: [{ id: 'responses-model' }] },
    } }), authorize, async () => { writes += 1; throw new Error('audit unavailable') })
    gateways.push(gateway)
    const body = { model: 'native/responses-model', input: [], stream: true }
    expect((await call(gateway, body)).status).toBe(400)
    expect((await call(gateway, body)).status).toBe(400)
    expect(writes).toBe(1)
    expect(upstream.paths).toEqual([])
  })

  it('does not dispatch the translated request when its audit write fails', async () => {
    const upstream = await fixture('responses')
    const phases: string[] = []
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: { baseURL: upstream.baseURL, apiFormat: 'responses', models: [{ id: 'responses-model' }] },
    } }), authorize, async (_binding, entry) => {
      phases.push(entry.phase)
      if (entry.phase === 'upstream-request') throw new Error('upstream audit unavailable')
    })
    gateways.push(gateway)
    const body = { model: 'native/responses-model', input: [], stream: true }
    expect((await call(gateway, body)).status).toBe(400)
    expect(phases).toEqual(['original-request', 'upstream-request'])
    expect(upstream.paths).toEqual([])
  })

  it('audits the routed native Responses request and raw result without altering either', async () => {
    const upstream = await fixture('responses')
    const records: CodexGatewayAuditEntry[] = []
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: { baseURL: upstream.baseURL, apiFormat: 'responses', models: [{ id: 'responses-model' }] },
    } }), authorize, async (_binding, entry) => { records.push(entry) })
    gateways.push(gateway)
    const body = {
      model: 'native/responses-model',
      instructions: 'Keep the original instructions.',
      input: [{ role: 'user', content: 'native audit' }],
      tools: [{ type: 'function', name: 'lookup', description: 'Find a value', parameters: {
        type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
      } }],
      tool_choice: 'auto', parallel_tool_calls: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      text: { format: { type: 'text' }, verbosity: 'low' },
      metadata: { trace: 'retain-me' }, prompt_cache_key: 'native-audit',
      stream: true,
    }
    const response = await call(gateway, body)
    const result = await response.text()
    expect(result).toContain('responses-ok')
    expect(records[0]).toMatchObject({ phase: 'original-request', payload: { rawBody: JSON.stringify(body) } })
    expect(records[1]).toMatchObject({ phase: 'upstream-request', payload: {
      url: `${upstream.baseURL}/responses`,
      rawBody: JSON.stringify({ ...body, model: 'responses-model' }),
    } })
    expect(upstream.bodies).toEqual([{ ...body, model: 'responses-model' }])
    expect((records[1]?.payload as { rawBody: string }).rawBody).toBe(upstream.rawBodies[0])
    const bytes = records.filter(record => record.phase === 'upstream-chunk')
      .map(record => Buffer.from((record.payload as { base64: string }).base64, 'base64').toString('utf8')).join('')
    expect(bytes).toBe(result)
    expect(bytes).toContain('"total_tokens":4')
    expect(records.at(-1)).toMatchObject({ phase: 'upstream-end', payload: { complete: true } })
  })

  it('routes a remote compaction payload, another attempt, and a model fallback through DSH', async () => {
    const primary = await fixture('responses')
    const fallback = await fixture('responses')
    const records: Array<{ binding: CodexGatewayRequestBinding; entry: CodexGatewayAuditEntry }> = []
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      primary: { baseURL: primary.baseURL, apiFormat: 'responses', models: [{ id: 'model-a' }] },
      fallback: { baseURL: fallback.baseURL, apiFormat: 'responses', models: [{ id: 'model-b' }] },
    } }), authorize, async (binding, entry) => { records.push({ binding, entry }) })
    gateways.push(gateway)
    const first = {
      model: 'primary/model-a', input: [{ type: 'message', role: 'user', content: 'history' }, { type: 'compaction_trigger' }],
      stream: true,
    }
    for (const body of [first, first, { ...first, model: 'fallback/model-b' }]) {
      const response = await call(gateway, body, gateway.token, codexTurnMetadata({ request_kind: 'compaction' }))
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(primary.paths).toEqual(['/v1/responses', '/v1/responses'])
    expect(fallback.paths).toEqual(['/v1/responses'])
    expect(primary.bodies).toEqual([first, first].map(body => ({ ...body, model: 'model-a' })))
    expect(fallback.bodies).toEqual([{ ...first, model: 'model-b' }])
    const attempts = [...new Set(records.map(record => record.binding.attemptId))]
    expect(attempts).toHaveLength(3)
    for (const attemptId of attempts) {
      const entries = records.filter(record => record.binding.attemptId === attemptId)
      expect(entries[0]?.binding.purpose).toBe('compaction')
      expect(entries[0]?.entry.phase).toBe('original-request')
      expect(entries[1]?.entry.phase).toBe('upstream-request')
      expect(entries.at(-1)?.entry.phase).toBe('upstream-end')
    }
  })

  it('cancels an interrupted native stream upstream and records its incomplete audit', async () => {
    const upstreamClosed = Promise.withResolvers<undefined>()
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"type":"response.output_text.delta","delta":"first"}\n\n')
        response.on('close', () => { upstreamClosed.resolve(undefined) })
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    servers.push(server)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture port')
    const records: CodexGatewayAuditEntry[] = []
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiFormat: 'responses', models: [{ id: 'model' }] },
    } }), authorize, async (_binding, entry) => { records.push(entry) })
    gateways.push(gateway)
    const controller = new AbortController()
    const response = await fetch(`${await gateway.ready}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json',
        'x-codex-turn-metadata': codexTurnMetadata(), 'x-dsh-model-attempt-id': randomUUID(),
      },
      body: JSON.stringify({ model: 'native/model', input: [], stream: true }),
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    expect((await reader?.read())?.done).toBe(false)
    controller.abort()
    await upstreamClosed.promise
    await vi.waitFor(() => {
      expect(records.some(record => record.phase === 'upstream-end'
        && !(record.payload as { complete: boolean }).complete)).toBe(true)
    })
    expect(records.some(record => record.phase === 'upstream-end'
      && (record.payload as { complete: boolean }).complete)).toBe(false)
  })

  it('applies the configured native provider timeout to the upstream stream', async () => {
    const upstreamClosed = Promise.withResolvers<undefined>()
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.flushHeaders()
        response.on('close', () => { upstreamClosed.resolve(undefined) })
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    servers.push(server)
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture port')
    const records: CodexGatewayAuditEntry[] = []
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiFormat: 'responses',
        timeoutMs: 40, models: [{ id: 'model' }] },
    } }), authorize, async (_binding, entry) => { records.push(entry) })
    gateways.push(gateway)
    await expect(call(gateway, { model: 'native/model', input: [], stream: true })).rejects.toThrow()
    await upstreamClosed.promise
    await vi.waitFor(() => {
      expect(records.some(record => record.phase === 'failure')).toBe(true)
      expect(records.some(record => record.phase === 'upstream-end'
        && !(record.payload as { complete: boolean }).complete)).toBe(true)
    })
  })

  it('rejects missing, mismatched, and unknown live turn identities before contacting a provider', async () => {
    const upstream = await fixture('responses')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: { baseURL: upstream.baseURL, apiFormat: 'responses', models: [{ id: 'responses-model' }] },
    } }), authorize, audit)
    gateways.push(gateway)
    const body = { model: 'native/responses-model', input: [], stream: true }
    expect((await call(gateway, body, gateway.token, codexTurnMetadata(), '')).status).toBe(400)
    expect((await call(gateway, body, gateway.token, codexTurnMetadata(), 'not-a-uuid')).status).toBe(400)
    expect((await call(gateway, body, gateway.token, null)).status).toBe(400)
    expect((await call(gateway, body, gateway.token, codexTurnMetadata({ thread_id: 'unknown' }))).status).toBe(400)
    expect((await call(gateway, body, gateway.token, codexTurnMetadata({ request_kind: 'memory' }))).status).toBe(400)
    expect((await call(gateway, body, gateway.token, codexTurnMetadata({ turn_id: 'old-turn' }))).status).toBe(400)
    expect((await call(gateway, {
      ...body, client_metadata: { 'x-codex-turn-metadata': codexTurnMetadata({ turn_id: 'other-turn' }) },
    })).status).toBe(400)
    expect(upstream.paths).toEqual([])

    const accepted = await call(gateway, body, gateway.token, codexTurnMetadata({ request_kind: 'compaction' }))
    expect(accepted.status).toBe(200)
    await accepted.text()
    expect(upstream.paths).toEqual(['/v1/responses'])
  })

  it('stores four paired request and response files only when logging is enabled', async () => {
    const upstream = await fixture('responses')
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-requests-'))
    logRoots.push(root)
    const providers = () => ({ providers: {
      native: {
        apiKeyEnv: 'FIXTURE_API_KEY',
        apiFormat: 'responses' as const,
        baseURL: upstream.baseURL,
        models: [{ id: 'responses-model' }],
      },
    } })
    const disabled = new CodexModelGateway(new Context(), providers, authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(disabled)
    const body = {
      model: 'native/responses-model',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private prompt' }] }],
      stream: true,
    }
    const disabledResponse = await call(disabled, body)
    expect(disabledResponse.status).toBe(200)
    await disabledResponse.text()
    await expect(readdir(join(root, 'disabled'))).rejects.toMatchObject({ code: 'ENOENT' })

    const directory = join(root, 'enabled')
    const enabled = new CodexModelGateway(new Context(), providers, authorize, audit, { FIXTURE_API_KEY: 'fixture-key' }, directory)
    gateways.push(enabled)
    expect((await call(enabled, body, 'wrong')).status).toBe(401)
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    const response = await call(enabled, body)
    expect(response.status).toBe(200)
    const output = await response.text()

    await vi.waitFor(async () => { expect(await readdir(directory)).toHaveLength(4) })
    const files = await readdir(directory)
    const prefix = files[0]?.replace(/_(input|output)_(headers|body)\.json$/, '')
    expect(files).toEqual([
      `${prefix}_input_body.json`, `${prefix}_input_headers.json`,
      `${prefix}_output_body.json`, `${prefix}_output_headers.json`,
    ])
    expect(JSON.parse(await readFile(join(directory, `${prefix}_input_body.json`), 'utf8'))).toEqual(body)
    const inputHeaders = JSON.parse(await readFile(join(directory, `${prefix}_input_headers.json`), 'utf8')) as {
      correlation: { attemptId: string }
    }
    expect(inputHeaders).toMatchObject({ method: 'POST', url: '/v1/responses', headers: { authorization: '[REDACTED]' } })
    expect(inputHeaders.correlation).toMatchObject({
      dshSessionId: 'dsh-session-1', dshTurn: 1, threadId: 'thread-1', turnId: 'turn-1', purpose: 'inference',
    })
    expect(inputHeaders.correlation.attemptId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(JSON.parse(await readFile(join(directory, `${prefix}_output_headers.json`), 'utf8'))).toMatchObject({
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
    expect(JSON.parse(await readFile(join(directory, `${prefix}_output_body.json`), 'utf8'))).toEqual({ body: output, complete: true })
    expect(await readFile(join(directory, `${prefix}_input_headers.json`), 'utf8')).not.toContain(enabled.token)
    expect(await readFile(join(directory, `${prefix}_input_headers.json`), 'utf8')).not.toContain('fixture-key')
  })

  it('records the converted Chat Completions stream and gateway errors', async () => {
    const upstream = await fixture('chat')
    const root = await mkdtemp(join(tmpdir(), 'dsh-codex-requests-'))
    logRoots.push(root)
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: {
        apiKeyEnv: 'FIXTURE_API_KEY', baseURL: upstream.baseURL, models: [{ id: 'chat-model' }],
      },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' }, root)
    gateways.push(gateway)

    const streamed = await call(gateway, {
      model: 'local/chat-model',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
    })
    const streamedBody = await streamed.text()
    const rejected = await call(gateway, { model: 'missing/model', input: [] })
    const rejectedBody = await rejected.text()
    expect(streamed.status).toBe(200)
    expect(rejected.status).toBe(400)

    await vi.waitFor(async () => { expect(await readdir(root)).toHaveLength(8) })
    const files = await readdir(root)
    const prefixes = [...new Set(files.map(file => file.replace(/_(input|output)_(headers|body)\.json$/, '')))]
    expect(prefixes).toHaveLength(2)
    for (const prefix of prefixes) {
      const input = JSON.parse(await readFile(join(root, `${prefix}_input_body.json`), 'utf8')) as { model: string }
      const output = JSON.parse(await readFile(join(root, `${prefix}_output_body.json`), 'utf8')) as { body: string }
      const headers = JSON.parse(await readFile(join(root, `${prefix}_output_headers.json`), 'utf8')) as { status: number }
      if (input.model === 'local/chat-model') {
        expect(output).toEqual({ body: streamedBody, complete: true })
        expect(headers.status).toBe(200)
      } else {
        expect(input.model).toBe('missing/model')
        expect(output).toEqual({ body: rejectedBody, complete: true })
        expect(headers.status).toBe(400)
      }
    }
  })

  it('defaults to Chat Completions and converts Responses history, tools, and streaming text', async () => {
    const upstream = await fixture('chat')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: {
        apiKeyEnv: 'FIXTURE_API_KEY',
        baseURL: upstream.baseURL,
        models: [{ id: 'chat-model' }],
      },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)

    const response = await call(gateway, {
      model: 'local/chat-model',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
      stream: true,
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('response.output_text.delta')
    expect(text).toContain('chat-ok')
    expect(text).toContain('response.completed')
    expect(upstream.paths).toEqual(['/v1/chat/completions'])
    expect(upstream.bodies[0]?.model).toBe('chat-model')
    expect(upstream.bodies[0]?.tools).toEqual([{
      type: 'function',
      function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' }, strict: false },
    }])
    const messages = upstream.bodies[0]?.messages
    expect(Array.isArray(messages) && messages.some((message) => {
      if (message === null || typeof message !== 'object') return false
      const record = message as Record<string, unknown>
      return record.role === 'assistant' && Array.isArray(record.tool_calls)
    })).toBe(true)
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
    ]))
  })

  it('preserves text roles, strict function schemas, tool choice, and parallel call history', async () => {
    const upstream = await fixture('chat-parallel')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: { baseURL: upstream.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'chat-model' }] },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const response = await call(gateway, {
      model: 'local/chat-model', instructions: 'top instruction', stream: true,
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev instruction' }] },
        { type: 'message', role: 'user', content: 'question' },
        { type: 'message', role: 'assistant', content: 'thinking aloud' },
        { type: 'function_call', call_id: 'old_a', name: 'lookup', arguments: '{"a":1}' },
        { type: 'function_call', call_id: 'old_b', name: 'lookup', arguments: '{"b":2}' },
        { type: 'function_call_output', call_id: 'old_a', output: 'result A' },
        { type: 'function_call_output', call_id: 'old_b', output: 'result B' },
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup',
        parameters: { type: 'object', properties: {} }, strict: true }],
      tool_choice: { type: 'function', name: 'lookup' }, parallel_tool_calls: true,
    })
    expect(response.status).toBe(200)
    const result = await response.text()
    expect(result).toContain('"call_id":"call_a"')
    expect(result).toContain('"call_id":"call_b"')
    expect(result).toContain('"input_tokens":12')
    expect(result).toContain('"cached_tokens":3')
    expect(upstream.bodies[0]).toMatchObject({
      messages: [
        { role: 'system', content: 'top instruction' },
        { role: 'developer', content: 'dev instruction' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'thinking aloud', tool_calls: [
          { id: 'old_a', function: { name: 'lookup', arguments: '{"a":1}' } },
          { id: 'old_b', function: { name: 'lookup', arguments: '{"b":2}' } },
        ] },
        { role: 'tool', tool_call_id: 'old_a', content: 'result A' },
        { role: 'tool', tool_call_id: 'old_b', content: 'result B' },
      ],
      tools: [{ type: 'function', function: {
        name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} }, strict: true,
      } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      parallel_tool_calls: true,
    })
  })

  it('returns a Responses failure event for an upstream Chat Completions error', async () => {
    const upstream = await fixture('chat-error')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: { baseURL: upstream.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'chat-model' }] },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const response = await call(gateway, { model: 'local/chat-model', input: 'hello', stream: true })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('response.failed')
    expect(text).toContain('fixture rate limit')
    expect(text).not.toContain('response.completed')
  })

  it('marks a Chat Completions length stop as incomplete instead of success', async () => {
    const upstream = await fixture('chat-length')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: { baseURL: upstream.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'chat-model' }] },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const response = await call(gateway, { model: 'local/chat-model', input: 'hello', stream: true })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('response.incomplete')
    expect(text).toContain('"reason":"max_output_tokens"')
    expect(text).not.toContain('response.completed')
  })

  it('never reports success for a Chat stream that ends without a terminal finish', async () => {
    const upstream = await fixture('chat-truncated')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: { baseURL: upstream.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'chat-model' }] },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const response = await call(gateway, { model: 'local/chat-model', input: 'hello', stream: true })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('response.failed')
    expect(text).not.toContain('response.completed')
  })

  it('rejects non-representable Responses reasoning history and hosted tools before upstream dispatch', async () => {
    const upstream = await fixture('chat')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: { baseURL: upstream.baseURL, apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'chat-model' }] },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)
    const reasoning = await call(gateway, { model: 'local/chat-model',
      input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'private' }] }], stream: true })
    expect(reasoning.status).toBe(400)
    expect(await reasoning.text()).toContain('cannot represent a Responses reasoning history item')
    const hostedTool = await call(gateway, { model: 'local/chat-model', input: 'hello',
      tools: [{ type: 'web_search' }], stream: true })
    expect(hostedTool.status).toBe(400)
    expect(await hostedTool.text()).toContain('does not support tool')
    expect(upstream.paths).toEqual([])
  })

  it('uses the native Responses transport when apiFormat is responses and rejects bad gateway auth', async () => {
    const upstream = await fixture('responses')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: {
        apiKeyEnv: 'FIXTURE_API_KEY',
        apiFormat: 'responses',
        baseURL: upstream.baseURL,
        models: [{ id: 'responses-model' }],
      },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)

    const denied = await call(gateway, { model: 'native/responses-model', input: [] }, 'wrong')
    expect(denied.status).toBe(401)
    const response = await call(gateway, {
      model: 'native/responses-model',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('responses-ok')
    expect(upstream.paths).toEqual(['/v1/responses'])
    expect(upstream.bodies[0]?.model).toBe('responses-model')
  })

  it('resolves the current Codex provider, wire format, model, and credential for each attempt', async () => {
    const chat = await fixture('chat')
    const native = await fixture('responses')
    const env: Record<string, string> = { CHAT_KEY: 'first-key', NATIVE_KEY: 'second-key' }
    let config: CodexModelGatewayConfig = { providers: {
      route: { baseURL: chat.baseURL, apiKeyEnv: 'CHAT_KEY', models: [{ id: 'shared-model' }] },
    } }
    const gateway = new CodexModelGateway(new Context(), () => config, authorize, audit, env)
    gateways.push(gateway)
    const body = { model: 'route/shared-model', input: [{ type: 'message', role: 'user', content: 'hello' }], stream: true }
    const first = await call(gateway, body)
    const firstText = await first.text()
    expect(first.status, firstText).toBe(200)
    expect(firstText).toContain('chat-ok')
    expect(chat.paths).toEqual(['/v1/chat/completions'])
    expect(chat.headers[0]?.authorization).toBe('Bearer first-key')

    config = { providers: {
      route: { baseURL: native.baseURL, apiKeyEnv: 'NATIVE_KEY', apiFormat: 'responses', models: [{ id: 'shared-model' }] },
    } }
    const second = await call(gateway, body)
    expect(second.status).toBe(200)
    expect(await second.text()).toContain('responses-ok')
    expect(native.paths).toEqual(['/v1/responses'])
    expect(native.headers[0]?.authorization).toBe('Bearer second-key')
    expect(native.bodies[0]?.model).toBe('shared-model')

    env.NATIVE_KEY = 'rotated-key'
    const rotated = await call(gateway, body)
    expect(rotated.status).toBe(200)
    expect(await rotated.text()).toContain('responses-ok')
    expect(native.headers[1]?.authorization).toBe('Bearer rotated-key')

    config = { providers: {
      route: { baseURL: native.baseURL, apiKeyEnv: 'NATIVE_KEY', apiFormat: 'responses', models: [{ id: 'other-model' }] },
    } }
    const removed = await call(gateway, body)
    expect(removed.status).toBe(400)
    expect(await removed.text()).toContain('not configured')
    expect(native.paths).toEqual(['/v1/responses', '/v1/responses'])
  })

  it('converts streamed Chat Completions tool calls back into Responses function calls', async () => {
    const upstream = await fixture('chat-tool')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: {
        apiKeyEnv: 'FIXTURE_API_KEY',
        baseURL: upstream.baseURL,
        models: [{ id: 'chat-model' }],
      },
    } }), authorize, audit, { FIXTURE_API_KEY: 'fixture-key' })
    gateways.push(gateway)

    const response = await call(gateway, {
      model: 'local/chat-model',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use a tool' }] }],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      stream: true,
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('response.function_call_arguments.delta')
    expect(text).toContain('response.function_call_arguments.done')
    expect(text).toContain('call_from_chat')
    expect(text).toContain('lookup')
    expect(text).toContain('\\"q\\":\\"x\\"')
  })
})


it('inspects gateway credentials through metadata without upstream or secret resolution', async () => {
  class MetadataCredentials extends CredentialProvider {
    resolve = vi.fn<CredentialProvider['resolve']>().mockRejectedValue(new Error('secret resolution forbidden'))
    describe = vi.fn<CredentialProvider['describe']>().mockResolvedValue({ configured: false, writable: false })
    set = vi.fn<CredentialProvider['set']>()
    unset = vi.fn<CredentialProvider['unset']>()
    readRecord = vi.fn<CredentialProvider['readRecord']>()
    describeRecord = vi.fn<CredentialProvider['describeRecord']>()
    listRecords = vi.fn<CredentialProvider['listRecords']>()
    modifyRecord = vi.fn<CredentialProvider['modifyRecord']>()
    deleteRecord = vi.fn<CredentialProvider['deleteRecord']>()
  }
  const ctx = new Context()
  await ctx.plugin(MetadataCredentials)
  const credentials = ctx.credentials as MetadataCredentials
  let config: CodexModelGatewayConfig = { providers: { local: {
    apiKeyEnv: 'PREVIEW_KEY', baseURL: 'http://unused.invalid/v1', models: [{ id: 'model' }],
  } } }
  const gateway = new CodexModelGateway(ctx, () => config, authorize, audit, { PREVIEW_KEY: 'must-not-fallback' })
  gateways.push(gateway)
  await gateway.ready
  try {
    await expect(gateway.describeAuthentication('local/model')).resolves.toEqual({ status: 'missing', reference: 'PREVIEW_KEY' })
    expect(credentials.describe).toHaveBeenCalledWith('PREVIEW_KEY')
    credentials.describe.mockResolvedValue({ configured: true, writable: false })
    await expect(gateway.describeAuthentication('local/model')).resolves.toEqual({ status: 'configured', reference: 'PREVIEW_KEY' })
    config = { providers: { local: { baseURL: 'http://unused.invalid/v1', models: [{ id: 'model' }] } } }
    await expect(gateway.describeAuthentication('local/model')).resolves.toEqual({ status: 'provider-managed' })
    await expect(gateway.describeAuthentication('absent/model')).rejects.toThrow('not configured')
    expect(credentials.resolve).not.toHaveBeenCalled()
    expect(credentials.readRecord).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})
