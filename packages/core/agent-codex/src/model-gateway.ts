/** Loopback Responses endpoint that routes Codex model calls through configured DSH providers. */

import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createAssistantMessage,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolCallId,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import {
  authContextFrom,
  credentialStoreFrom,
  PiAiAdapter,
  resolveProfiles,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { Config as PiAiConfig, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024

function loggedHeaders(request: IncomingMessage): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [
    name,
    /authorization|cookie|api[-_]?key|token|secret|password/i.test(name) ? '[REDACTED]' : value,
  ]))
}

class GatewayRequestLog {
  private readonly decoder = new StringDecoder('utf8')
  private closed = false
  private outputHeaders: { status: number; headers: Record<string, string> } | undefined

  private constructor(
    private readonly directory: string,
    private readonly prefix: string,
    private readonly outputBodyFd: number,
  ) {}

  static async create(directory: string, request: IncomingMessage, body: Record<string, unknown>): Promise<GatewayRequestLog> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}`
    await writeFile(join(directory, `${prefix}_input_headers.json`), `${JSON.stringify({
      method: request.method, url: request.url, headers: loggedHeaders(request),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(join(directory, `${prefix}_input_body.json`), `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const fd = openSync(join(directory, `${prefix}_output_body.json`), 'wx', 0o600)
    writeSync(fd, '{"body":"')
    return new GatewayRequestLog(directory, prefix, fd)
  }

  appendOutput(chunk: string | Uint8Array): void {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk))
    if (decoded.length > 0) writeSync(this.outputBodyFd, JSON.stringify(decoded).slice(1, -1))
  }

  recordOutputHeaders(status: number, headers: Record<string, string>): void {
    this.outputHeaders = { status, headers }
  }

  async finish(response: ServerResponse): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      const trailing = this.decoder.end()
      if (trailing.length > 0) writeSync(this.outputBodyFd, JSON.stringify(trailing).slice(1, -1))
      writeSync(this.outputBodyFd, `","complete":${response.writableEnded}}\n`)
    } finally {
      closeSync(this.outputBodyFd)
    }
    await writeFile(join(this.directory, `${this.prefix}_output_headers.json`), `${JSON.stringify(
      this.outputHeaders ?? { status: response.statusCode, headers: response.getHeaders() }, null, 2,
    )}\n`, { flag: 'wx', mode: 0o600 })
  }
}

/** Wire protocol exposed by one Codex provider profile. */
export type CodexApiFormat = 'chat-completions' | 'responses'

/** A Codex provider repeats the normal DSH model profile and adds its wire format. */
export interface CodexProviderProfile extends PiAiProviderProfile {
  /** Upstream wire format; omission selects the common Chat Completions API. */
  apiFormat?: CodexApiFormat
}

/** Settings-owned provider catalog used only by the full Codex agent. */
export interface CodexModelGatewayConfig {
  providers?: Record<string, CodexProviderProfile>
}

/** Reject a gateway snapshot before settings publishes it. */
export function assertCodexGatewayServiceable(config: CodexModelGatewayConfig): void {
  resolveProfiles(translatedProfiles(config))
}

/** One model exposed under the full-agent `codex` route. */
export interface CodexGatewayModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly ('text' | 'image')[]
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string }[]
  }
}

interface Route {
  readonly provider: string
  readonly model: string
}

/** Model route exposed to the Codex app-server for one DSH provider/model pair.
 * @param provider - DSH provider id.
 * @param model - provider-owned model id.
 * @returns the encoded Codex gateway model id.
 */
export function codexGatewayModelId(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}

function providerProfiles(config: CodexModelGatewayConfig): Record<string, CodexProviderProfile> {
  return config.providers ?? {}
}

/** Build selector entries from the explicit models in `codex.providers`. */
export function codexGatewayModels(config: CodexModelGatewayConfig): CodexGatewayModel[] {
  return Object.entries(providerProfiles(config)).flatMap(([provider, profile]) => (profile.models ?? []).map(model => ({
    id: codexGatewayModelId(provider, model.id),
    name: model.name ?? model.id,
    description: `${profile.displayName ?? provider} · ${model.id}`,
    // The Responses-to-DSH request converter currently accepts text only.
    inputModalities: ['text'] as const,
    ...model.reasoningEfforts === undefined || model.reasoningEfforts === false
      ? {}
      : {
        reasoning: {
          efforts: Object.keys(model.reasoningEfforts).map(id => ({ id, name: id })),
        },
      },
  })))
}

function resolveRoute(config: CodexModelGatewayConfig, id: unknown): Route {
  if (typeof id !== 'string') throw new Error('agent-codex gateway request has no model')
  for (const [provider, profile] of Object.entries(providerProfiles(config))) {
    for (const model of profile.models ?? []) {
      if (codexGatewayModelId(provider, model.id) === id) return { provider, model: model.id }
    }
  }
  throw new Error(`agent-codex gateway model ${JSON.stringify(id)} is not configured`)
}

function translatedProfiles(config: CodexModelGatewayConfig): PiAiConfig['providers'] {
  return Object.fromEntries(Object.entries(providerProfiles(config)).map(([provider, profile]) => {
    const { apiFormat: _apiFormat, ...shared } = profile
    return [provider, {
      ...shared,
      api: profile.apiFormat === 'responses' ? 'openai-responses' : 'openai-completions',
    }]
  }))
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) {
        request.destroy(new Error('agent-codex gateway request exceeded its byte limit'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('request body must be an object')
        }
        resolve(value as Record<string, unknown>)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    request.on('error', reject)
  })
}

function textParts(value: unknown): ContentBlock[] {
  if (typeof value === 'string') return value.length === 0 ? [] : [{ type: 'text', text: value }]
  if (!Array.isArray(value)) throw new Error('agent-codex gateway message content must be an array or string')
  return value.flatMap((part): ContentBlock[] => {
    if (part === null || typeof part !== 'object') throw new Error('agent-codex gateway received an invalid content part')
    const record = part as Record<string, unknown>
    if (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text') {
      if (typeof record.text !== 'string') throw new Error('agent-codex gateway text part has no text')
      return record.text.length === 0 ? [] : [{ type: 'text', text: record.text }]
    }
    if (record.type === 'input_image') {
      throw new Error('agent-codex gateway Chat Completions adapter does not yet support image input')
    }
    throw new Error(`agent-codex gateway does not support content part ${JSON.stringify(record.type)}`)
  })
}

function toolCallId(value: unknown): ToolCallId {
  if (typeof value !== 'string' || value.length === 0) throw new Error('agent-codex gateway tool call has no call_id')
  return brandString<ToolCallId>(value)
}

function messagesOf(body: Record<string, unknown>, route: Route): Message[] {
  if (!Array.isArray(body.input)) throw new Error('agent-codex gateway request input must be an array')
  const messages: Message[] = []
  for (const item of body.input) {
    if (item === null || typeof item !== 'object') throw new Error('agent-codex gateway received an invalid input item')
    const record = item as Record<string, unknown>
    if (record.type === 'reasoning') continue
    if (record.type === 'function_call') {
      if (typeof record.name !== 'string' || typeof record.arguments !== 'string') {
        throw new Error('agent-codex gateway received an invalid function_call')
      }
      messages.push(createAssistantMessage({
        content: [{
          type: 'tool-call',
          id: toolCallId(record.call_id),
          name: record.name,
          arguments: record.arguments,
        }],
        source: { provider: route.provider, model: route.model },
      }))
      continue
    }
    if (record.type === 'function_call_output') {
      const output = typeof record.output === 'string' ? record.output : JSON.stringify(record.output)
      messages.push(createToolResultMessage({
        callId: toolCallId(record.call_id),
        content: [{ type: 'text', text: output }],
        isError: false,
      }))
      continue
    }
    if (record.type !== 'message') {
      throw new Error(`agent-codex gateway does not support input item ${JSON.stringify(record.type)}`)
    }
    const content = textParts(record.content)
    switch (record.role) {
      case 'user':
        messages.push(createUserMessage({ content, source: { kind: 'user' } }))
        break
      case 'assistant':
        messages.push(createAssistantMessage({ content, source: { provider: route.provider, model: route.model } }))
        break
      case 'system':
      case 'developer':
        messages.push(createMessage({ role: 'system', content, source: { kind: 'plugin', plugin: 'agent-codex' } }))
        break
      default:
        throw new Error(`agent-codex gateway does not support message role ${JSON.stringify(record.role)}`)
    }
  }
  return messages
}

function toolsOf(body: Record<string, unknown>): ToolSchema[] | undefined {
  if (body.tools === undefined) return undefined
  if (!Array.isArray(body.tools)) throw new Error('agent-codex gateway tools must be an array')
  const result: ToolSchema[] = []
  const append = (tool: unknown, namespace?: string): void => {
    if (tool === null || typeof tool !== 'object') throw new Error('agent-codex gateway received an invalid tool')
    const record = tool as Record<string, unknown>
    if (record.type === 'namespace') {
      if (typeof record.name !== 'string' || !Array.isArray(record.tools)) {
        throw new Error('agent-codex gateway received an invalid tool namespace')
      }
      for (const child of record.tools) append(child, record.name)
      return
    }
    if (record.type !== 'function' || typeof record.name !== 'string') {
      // Chat Completions has no representation for Responses-native hosted tools
      // such as web_search. Codex's local function tools remain available.
      return
    }
    if (result.some(tool => tool.name === record.name)) {
      throw new Error(`agent-codex Chat Completions adapter found duplicate tool ${JSON.stringify(record.name)}`)
    }
    result.push({
      name: record.name,
      description: [namespace === undefined ? undefined : `Namespace: ${namespace}.`, record.description]
        .filter(value => typeof value === 'string').join(' '),
      parameters: record.parameters !== null && typeof record.parameters === 'object' && !Array.isArray(record.parameters)
        ? record.parameters as Record<string, unknown>
        : {},
    })
  }
  for (const tool of body.tools) append(tool)
  return result
}

function generateOptions(body: Record<string, unknown>, route: Route, signal: AbortSignal): GenerateOptions {
  const reasoning = body.reasoning !== null && typeof body.reasoning === 'object' && !Array.isArray(body.reasoning)
    ? (body.reasoning as Record<string, unknown>).effort
    : undefined
  const tools = toolsOf(body)
  return {
    provider: route.provider,
    model: route.model,
    messages: messagesOf(body, route),
    ...typeof body.instructions === 'string' ? { system: body.instructions } : {},
    ...tools === undefined ? {} : { tools },
    ...typeof body.temperature === 'number' ? { temperature: body.temperature } : {},
    ...typeof body.max_output_tokens === 'number' ? { maxTokens: body.max_output_tokens } : {},
    ...typeof reasoning === 'string' && reasoning !== 'none'
      ? { reasoningEffort: ReasoningEffortId(reasoning) }
      : {},
    signal,
  }
}

function responseObject(
  id: string,
  model: string,
  output: readonly Record<string, unknown>[],
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: usage ?? {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    metadata: {},
  }
}

async function streamAsResponses(
  response: ServerResponse,
  stream: AsyncIterable<StreamChunk>,
  model: string,
  requestLog?: GatewayRequestLog,
): Promise<void> {
  const emit = (event: Record<string, unknown>): void => {
    const data = `data: ${JSON.stringify(event)}\n\n`
    requestLog?.appendOutput(data)
    response.write(data)
  }
  const end = (): void => {
    const data = 'data: [DONE]\n\n'
    requestLog?.appendOutput(data)
    response.end(data)
  }
  const responseId = `resp_${randomUUID()}`
  const output: Array<Record<string, unknown> | undefined> = []
  const states = new Map<number,
    { id: string; outputIndex: number; kind: 'text'; text: string }
    | { id: string; outputIndex: number; kind: 'tool'; callId: string; name: string; arguments: string }
  >()
  let nextOutputIndex = 0
  let usage: Record<string, unknown> | undefined
  const responseHeaders = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': responseId,
  }
  requestLog?.recordOutputHeaders(200, responseHeaders)
  response.writeHead(200, responseHeaders)
  emit({ type: 'response.created', response: { ...responseObject(responseId, model, []), status: 'in_progress' } })
  for await (const chunk of stream) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      const id = `msg_${randomUUID()}`
      const outputIndex = nextOutputIndex++
      states.set(chunk.index, { id, outputIndex, kind: 'text', text: '' })
      emit({
        type: 'response.output_item.added', output_index: outputIndex,
        item: { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      })
      emit({
        type: 'response.content_part.added', item_id: id, output_index: outputIndex, content_index: 0,
        part: { type: 'output_text', annotations: [], logprobs: [], text: '' },
      })
    } else if (chunk.type === 'text-delta') {
      const state = states.get(chunk.index)
      if (state?.kind !== 'text') throw new Error('agent-codex gateway received text outside a text block')
      state.text += chunk.text
      emit({
        type: 'response.output_text.delta', item_id: state.id, output_index: state.outputIndex,
        content_index: 0, delta: chunk.text, logprobs: [],
      })
    } else if (chunk.type === 'tool-call-delta') {
      let state = states.get(chunk.index)
      if (state === undefined) {
        if (chunk.name === undefined) throw new Error('agent-codex gateway tool call begins without a name')
        state = {
          id: `fc_${randomUUID()}`,
          outputIndex: nextOutputIndex++,
          kind: 'tool',
          callId: String(chunk.id),
          name: chunk.name,
          arguments: '',
        }
        states.set(chunk.index, state)
        emit({
          type: 'response.output_item.added', output_index: state.outputIndex,
          item: { id: state.id, type: 'function_call', status: 'in_progress', name: state.name, arguments: '', call_id: state.callId },
        })
      }
      if (state.kind !== 'tool') throw new Error('agent-codex gateway received tool arguments outside a tool block')
      state.arguments += chunk.argumentsDelta
      emit({
        type: 'response.function_call_arguments.delta', item_id: state.id,
        output_index: state.outputIndex, delta: chunk.argumentsDelta,
      })
    } else if (chunk.type === 'block-end') {
      const state = states.get(chunk.index)
      if (state?.kind === 'text') {
        const part = { type: 'output_text', annotations: [], logprobs: [], text: state.text }
        const item = { id: state.id, type: 'message', status: 'completed', role: 'assistant', content: [part] }
        emit({ type: 'response.output_text.done', item_id: state.id, output_index: state.outputIndex, content_index: 0, text: state.text, logprobs: [] })
        emit({ type: 'response.content_part.done', item_id: state.id, output_index: state.outputIndex, content_index: 0, part })
        emit({ type: 'response.output_item.done', output_index: state.outputIndex, item })
        output[state.outputIndex] = item
      } else if (state?.kind === 'tool') {
        const item = { id: state.id, type: 'function_call', status: 'completed', name: state.name, arguments: state.arguments, call_id: state.callId }
        emit({ type: 'response.function_call_arguments.done', item_id: state.id, output_index: state.outputIndex, arguments: state.arguments })
        emit({ type: 'response.output_item.done', output_index: state.outputIndex, item })
        output[state.outputIndex] = item
      }
    } else if (chunk.type === 'usage') {
      usage = {
        input_tokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
        input_tokens_details: { cached_tokens: chunk.usage.cacheReadTokens ?? 0 },
        output_tokens: chunk.usage.outputTokens,
        output_tokens_details: { reasoning_tokens: chunk.usage.reasoningTokens ?? 0 },
        total_tokens: chunk.usage.totalTokens ?? chunk.usage.inputTokens + chunk.usage.outputTokens,
      }
    } else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      emit({
        type: 'response.failed',
        response: {
          ...responseObject(responseId, model, output.filter(item => item !== undefined), usage),
          status: 'failed',
          error: { code: chunk.reason.failure.code, message: chunk.reason.failure.message },
        },
      })
      end()
      return
    }
  }
  emit({
    type: 'response.completed',
    response: responseObject(responseId, model, output.filter(item => item !== undefined), usage),
  })
  end()
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    server.closeAllConnections()
  })
}

/** Local authenticated endpoint consumed only by the deployment-owned Codex process. */
export class CodexModelGateway {
  readonly token = randomUUID()
  readonly ready: Promise<string>
  private readonly server: Server
  private readonly adapter: PiAiAdapter

  constructor(
    private readonly ctx: Context,
    private readonly config: () => CodexModelGatewayConfig,
    private readonly env: Readonly<Record<string, string>> = {},
    private readonly requestLogDir?: string,
  ) {
    this.adapter = new PiAiAdapter({
      profiles: () => resolveProfiles(translatedProfiles(this.config())),
      resolveApiKey: async (_provider, profile) => this.resolveApiKey(profile.apiKeyEnv),
      auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
    })
    this.server = createServer((request, response) => { void this.handle(request, response) })
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        const address = this.server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('agent-codex gateway did not acquire a TCP port'))
          return
        }
        resolve(`http://127.0.0.1:${address.port}/v1`)
      })
    })
  }

  /** Stop accepting calls and abort all loopback connections. */
  async dispose(): Promise<void> {
    await closeServer(this.server)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let requestLog: GatewayRequestLog | undefined
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end()
        return
      }
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid Codex gateway credential' } }))
        return
      }
      const body = await readBody(request)
      if (this.requestLogDir !== undefined) {
        requestLog = await GatewayRequestLog.create(this.requestLogDir, request, body)
      }
      const route = resolveRoute(this.config(), body.model)
      const controller = new AbortController()
      response.on('close', () => { controller.abort('Codex gateway client disconnected') })
      const profile = providerProfiles(this.config())[route.provider]
      if (profile?.apiFormat === 'responses') {
        await this.proxyResponses(response, body, route, profile, controller.signal, requestLog)
        return
      }
      await streamAsResponses(response, this.adapter.stream(generateOptions(body, route, controller.signal)), String(body.model), requestLog)
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const responseHeaders = { 'content-type': 'application/json' }
      requestLog?.recordOutputHeaders(400, responseHeaders)
      response.writeHead(400, responseHeaders)
      const payload = JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })
      requestLog?.appendOutput(payload)
      response.end(payload)
    } finally {
      try {
        await requestLog?.finish(response)
      } catch (error) {
        console.error('agent-codex gateway could not finish request log', error)
      }
    }
  }

  private async resolveApiKey(ref: string | undefined): Promise<string | undefined> {
    if (ref === undefined) return undefined
    const credentials = this.ctx.get('credentials')
    const value = credentials === undefined
      ? this.env[ref] ?? process.env[ref]
      : (await credentials.resolve(credentialRef(ref)))?.value
    if (value === undefined || value.length === 0) {
      throw new Error(`agent-codex gateway credential ${ref} is not configured`)
    }
    return value
  }

  /** Preserve native Responses requests and SSE events byte-for-byte except for gateway routing. */
  private async proxyResponses(
    response: ServerResponse,
    body: Record<string, unknown>,
    route: Route,
    profile: CodexProviderProfile,
    signal: AbortSignal,
    requestLog?: GatewayRequestLog,
  ): Promise<void> {
    if (profile.baseURL === undefined) {
      throw new Error(`agent-codex native Responses provider ${JSON.stringify(route.provider)} requires baseURL`)
    }
    const apiKey = await this.resolveApiKey(profile.apiKeyEnv)
    const upstream = await fetch(`${profile.baseURL.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        ...profile.headers,
        'content-type': 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      },
      body: JSON.stringify({ ...body, model: route.model }),
      signal,
    })
    const responseHeaders = {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      ...upstream.headers.get('x-request-id') === null
        ? {}
        : { 'x-request-id': upstream.headers.get('x-request-id') as string },
    }
    requestLog?.recordOutputHeaders(upstream.status, responseHeaders)
    response.writeHead(upstream.status, responseHeaders)
    if (upstream.body === null) {
      response.end()
      return
    }
    const reader = upstream.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        requestLog?.appendOutput(chunk.value)
        response.write(chunk.value)
      }
      response.end()
    } finally {
      reader.releaseLock()
    }
  }
}
