import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CodexModelGateway } from '../src/model-gateway.ts'

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

async function fixture(kind: 'chat' | 'chat-tool' | 'responses'): Promise<{
  baseURL: string
  paths: string[]
  bodies: Record<string, unknown>[]
}> {
  const paths: string[] = []
  const bodies: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { raw += chunk })
    request.on('end', () => {
      paths.push(request.url ?? '')
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (kind === 'chat') {
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"chat-ok"},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n')
      } else if (kind === 'chat-tool') {
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_from_chat","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":null}]}\n\n')
        response.write('data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1,"model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n')
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
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, paths, bodies }
}

async function call(gateway: CodexModelGateway, body: Record<string, unknown>, token: string = gateway.token): Promise<Response> {
  return fetch(`${await gateway.ready}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('CodexModelGateway', () => {
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
    const disabled = new CodexModelGateway(new Context(), providers, { FIXTURE_API_KEY: 'fixture-key' })
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
    const enabled = new CodexModelGateway(new Context(), providers, { FIXTURE_API_KEY: 'fixture-key' }, directory)
    gateways.push(enabled)
    expect((await call(enabled, body, 'wrong')).status).toBe(401)
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    const response = await call(enabled, body)
    expect(response.status).toBe(200)
    const output = await response.text()

    await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(4))
    const files = await readdir(directory)
    const prefix = files[0]?.replace(/_(input|output)_(headers|body)\.json$/, '')
    expect(files).toEqual([
      `${prefix}_input_body.json`, `${prefix}_input_headers.json`,
      `${prefix}_output_body.json`, `${prefix}_output_headers.json`,
    ])
    expect(JSON.parse(await readFile(join(directory, `${prefix}_input_body.json`), 'utf8'))).toEqual(body)
    const inputHeaders = JSON.parse(await readFile(join(directory, `${prefix}_input_headers.json`), 'utf8'))
    expect(inputHeaders).toMatchObject({ method: 'POST', url: '/v1/responses', headers: { authorization: '[REDACTED]' } })
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
    } }), { FIXTURE_API_KEY: 'fixture-key' }, root)
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

    await vi.waitFor(async () => expect(await readdir(root)).toHaveLength(8))
    const files = await readdir(root)
    const prefixes = [...new Set(files.map(file => file.replace(/_(input|output)_(headers|body)\.json$/, '')))]
    expect(prefixes).toHaveLength(2)
    for (const prefix of prefixes) {
      const input = JSON.parse(await readFile(join(root, `${prefix}_input_body.json`), 'utf8'))
      const output = JSON.parse(await readFile(join(root, `${prefix}_output_body.json`), 'utf8'))
      const headers = JSON.parse(await readFile(join(root, `${prefix}_output_headers.json`), 'utf8'))
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
    } }), { FIXTURE_API_KEY: 'fixture-key' })
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

  it('uses the native Responses transport when apiFormat is responses and rejects bad gateway auth', async () => {
    const upstream = await fixture('responses')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      native: {
        apiKeyEnv: 'FIXTURE_API_KEY',
        apiFormat: 'responses',
        baseURL: upstream.baseURL,
        models: [{ id: 'responses-model' }],
      },
    } }), { FIXTURE_API_KEY: 'fixture-key' })
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

  it('converts streamed Chat Completions tool calls back into Responses function calls', async () => {
    const upstream = await fixture('chat-tool')
    const gateway = new CodexModelGateway(new Context(), () => ({ providers: {
      local: {
        apiKeyEnv: 'FIXTURE_API_KEY',
        baseURL: upstream.baseURL,
        models: [{ id: 'chat-model' }],
      },
    } }), { FIXTURE_API_KEY: 'fixture-key' })
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
