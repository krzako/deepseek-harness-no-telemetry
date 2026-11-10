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
  LlmAuthenticationInfo,
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
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024

function loggedHeaders(request: IncomingMessage): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) => value === undefined ? [] : [[
    name,
    /authorization|cookie|api[-_]?key|token|secret|password/i.test(name) ? '[REDACTED]' : value,
  ]]))
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

  static async create(
    directory: string, request: IncomingMessage, body: Record<string, unknown>, binding: CodexGatewayRequestBinding,
  ): Promise<GatewayRequestLog> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}`
    await writeFile(join(directory, `${prefix}_input_headers.json`), `${JSON.stringify({
      method: request.method, url: request.url, headers: loggedHeaders(request), correlation: binding,
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

/** Codex-owned request identity authenticated against one live DSH Session. */
export interface CodexGatewayRequestMetadata {
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly purpose: 'inference' | 'compaction'
  readonly attemptId: string
}

/** DSH-owned correlation for one upstream model attempt. */
export interface CodexGatewayRequestBinding extends CodexGatewayRequestMetadata {
  readonly dshSessionId: string
  readonly dshTurn: number
}

/** One audit fact persisted before its corresponding transport action becomes visible. */
export interface CodexGatewayAuditEntry {
  readonly phase: 'original-request' | 'upstream-request' | 'upstream-response' | 'upstream-chunk' | 'upstream-end' | 'result' | 'failure'
  readonly payload: JsonValue
}

/** Required durable writer; rejection stops this gateway from issuing further model calls. */
export type CodexGatewayAuditWriter = (
  binding: CodexGatewayRequestBinding, entry: CodexGatewayAuditEntry,
) => Promise<void>

function safeTransportHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].map(([name, value]) => [
    name, /authorization|cookie|api[-_]?key|token|secret|password/i.test(name) ? '[REDACTED]' : value,
  ]))
}

function writeDownstream(response: ServerResponse, chunk: string | Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (response.destroyed) return Promise.reject(new Error('Codex gateway client disconnected'))
  if (response.write(chunk)) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', drained)
      response.off('close', closed)
      signal.removeEventListener('abort', aborted)
    }
    const drained = (): void => { cleanup(); resolve() }
    const closed = (): void => { cleanup(); reject(new Error('Codex gateway client disconnected')) }
    const aborted = (): void => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    }
    response.once('drain', drained)
    response.once('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (response.destroyed) closed()
  })
}

/** Resolve only a registered, active Codex turn; undefined denies the request. */
export type CodexGatewayRequestAuthorizer = (
  metadata: CodexGatewayRequestMetadata,
) => { readonly dshSessionId: string; readonly dshTurn: number } | undefined

function requestMetadata(request: IncomingMessage, body: Record<string, unknown>): CodexGatewayRequestMetadata {
  const attemptId = request.headers['x-dsh-model-attempt-id']
  if (typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
    throw new Error('agent-codex gateway request has no valid model attempt id')
  }
  const header = request.headers['x-codex-turn-metadata']
  if (typeof header !== 'string') throw new Error('agent-codex gateway request has no Codex turn metadata')
  let value: unknown
  try { value = JSON.parse(header) } catch { throw new Error('agent-codex gateway has invalid Codex turn metadata') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent-codex gateway has invalid Codex turn metadata')
  }
  const metadata = value as Record<string, unknown>
  const sessionId = metadata.session_id
  const threadId = metadata.thread_id
  const turnId = metadata.turn_id
  const kind = metadata.request_kind
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof threadId !== 'string' || threadId.length === 0
    || typeof turnId !== 'string' || turnId.length === 0 || (kind !== 'turn' && kind !== 'compaction')) {
    throw new Error('agent-codex gateway request has incomplete or unsupported Codex turn identity')
  }
  const clientMetadata = body.client_metadata
  if (clientMetadata !== null && typeof clientMetadata === 'object' && !Array.isArray(clientMetadata)) {
    const bodyHeader = (clientMetadata as Record<string, unknown>)['x-codex-turn-metadata']
    if (bodyHeader !== undefined) {
      if (typeof bodyHeader !== 'string') throw new Error('agent-codex gateway has invalid body turn metadata')
      let bodyValue: unknown
      try { bodyValue = JSON.parse(bodyHeader) } catch { throw new Error('agent-codex gateway has invalid body turn metadata') }
      if (bodyValue === null || typeof bodyValue !== 'object' || Array.isArray(bodyValue)) {
        throw new Error('agent-codex gateway has invalid body turn metadata')
      }
      const bodyRecord = bodyValue as Record<string, unknown>
      if (bodyRecord.session_id !== sessionId || bodyRecord.thread_id !== threadId
        || bodyRecord.turn_id !== turnId || bodyRecord.request_kind !== kind) {
        throw new Error('agent-codex gateway header and body turn identity differ')
      }
    }
  }
  return { sessionId, threadId, turnId, purpose: kind === 'turn' ? 'inference' : 'compaction', attemptId }
}

/** Reject a gateway snapshot before settings publishes it.
 * @param config - complete proposed Codex provider configuration.
 */
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

/** Build selector entries from the explicit models in `codex.providers`.
 * @param config - proposed Codex provider configuration.
 * @returns model entries advertised to the app-server.
 */
export function codexGatewayModels(config: CodexModelGatewayConfig): CodexGatewayModel[] {
  const resolved = resolveProfiles(translatedProfiles(config))
  return Object.entries(providerProfiles(config)).flatMap(([provider, profile]) => (profile.models ?? []).map(model => ({
    id: codexGatewayModelId(provider, model.id),
    name: model.name ?? model.id,
    description: `${profile.displayName ?? provider} · ${model.id}`,
    inputModalities: resolved.get(provider)?.piProvider.getModels().find(candidate => candidate.id === model.id)?.input ?? ['text'],
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

function modelSupportsImage(config: CodexModelGatewayConfig, route: Route): boolean {
  const model = resolveProfiles(translatedProfiles(config)).get(route.provider)?.piProvider.getModels()
    .find(candidate => candidate.id === route.model)
  if (model === undefined) throw new Error(`agent-codex gateway model ${JSON.stringify(route.model)} did not resolve`)
  return model.input.includes('image')
}

function assertDeclaredImageInput(body: Record<string, unknown>, supportsImage: boolean): void {
  if (supportsImage || !Array.isArray(body.input)) return
  for (const item of body.input) {
    if (item === null || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    if (Array.isArray(content) && content.some(part => part !== null && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'input_image')) {
      throw new Error('agent-codex selected model does not declare image input')
    }
  }
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

function readBody(request: IncomingMessage): Promise<{ parsed: Record<string, unknown>; raw: string }> {
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
        const raw = Buffer.concat(chunks).toString('utf8')
        const value: unknown = JSON.parse(raw)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('request body must be an object')
        }
        resolve({ parsed: value as Record<string, unknown>, raw })
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

function chatText(value: unknown): string {
  return textParts(value).map((part) => {
    if (part.type !== 'text') throw new Error('agent-codex Chat Completions adapter expected text content')
    return part.text
  }).join('')
}

function piContextParts(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return textParts(value)
  // This provider-neutral context is only used to drive pi-ai's stream parser.
  // chatFetch replaces its outbound messages with the exact image-bearing translation.
  return value.flatMap((part): ContentBlock[] => {
    if (part !== null && typeof part === 'object' && (part as Record<string, unknown>).type === 'input_image') {
      return [{ type: 'text', text: '[image sent in Chat request]' }]
    }
    return textParts([part])
  })
}

function chatImagePart(value: Record<string, unknown>, supportsImage: boolean): Record<string, unknown> {
  if (!supportsImage) throw new Error('agent-codex selected model does not declare image input')
  if (typeof value.image_url !== 'string' || !/^(https?:\/\/|data:image\/[a-z0-9.+-]+;base64,)/i.test(value.image_url)) {
    throw new Error('agent-codex Chat Completions image requires an HTTP(S) or base64 data URL')
  }
  if (value.detail !== undefined && value.detail !== 'auto' && value.detail !== 'low'
    && value.detail !== 'high' && value.detail !== 'original') {
    throw new Error('agent-codex Chat Completions image has unsupported detail')
  }
  if (value.file_id !== undefined) {
    throw new Error('agent-codex Chat Completions adapter cannot represent an image file_id')
  }
  return { type: 'image_url', image_url: {
    url: value.image_url,
    ...value.detail === undefined ? {} : { detail: value.detail },
  } }
}

function chatContent(value: unknown, role: string, supportsImage: boolean): string | Record<string, unknown>[] {
  if (typeof value === 'string') return value
  if (value === null) return ''
  if (!Array.isArray(value)) throw new Error('agent-codex gateway message content must be an array or string')
  const parts = value.map((part): Record<string, unknown> => {
    if (part === null || typeof part !== 'object') throw new Error('agent-codex gateway received an invalid content part')
    const record = part as Record<string, unknown>
    if (record.type === 'input_image') {
      if (role !== 'user') throw new Error('agent-codex Chat Completions supports image input only in user messages')
      return chatImagePart(record, supportsImage)
    }
    if (record.type !== 'input_text' && record.type !== 'output_text' && record.type !== 'text') {
      throw new Error(`agent-codex Chat Completions adapter does not support content part ${JSON.stringify(record.type)}`)
    }
    if (typeof record.text !== 'string') throw new Error('agent-codex gateway text part has no text')
    return { type: 'text', text: record.text }
  })
  return parts.some(part => part.type === 'image_url') ? parts : parts.map(part => part.text).join('')
}

interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string | Record<string, unknown>[]
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

function chatMessages(body: Record<string, unknown>, supportsImage: boolean): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== 'string') {
      throw new Error('agent-codex Chat Completions adapter supports only text instructions')
    }
    messages.push({ role: 'system', content: body.instructions })
  }
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
  if (!Array.isArray(input)) throw new Error('agent-codex gateway request input must be an array or string')
  for (const item of input) {
    if (item === null || typeof item !== 'object') throw new Error('agent-codex gateway received an invalid input item')
    const record = item as Record<string, unknown>
    if (record.type === 'function_call') {
      const id = toolCallId(record.call_id)
      if (typeof record.name !== 'string' || record.name.length === 0 || typeof record.arguments !== 'string') {
        throw new Error('agent-codex gateway received an invalid function_call')
      }
      const last = messages.at(-1)
      const assistant = last?.role === 'assistant' ? last : { role: 'assistant' as const, content: '' }
      if (last !== assistant) messages.push(assistant)
      assistant.tool_calls ??= []
      assistant.tool_calls.push({ id, type: 'function', function: { name: record.name, arguments: record.arguments } })
      continue
    }
    if (record.type === 'function_call_output') {
      if (record.output === undefined) throw new Error('agent-codex gateway function_call_output has no output')
      const output = typeof record.output === 'string' ? record.output
        : Array.isArray(record.output) ? chatText(record.output) : JSON.stringify(record.output)
      messages.push({ role: 'tool', tool_call_id: toolCallId(record.call_id), content: output })
      continue
    }
    if (record.type === 'reasoning') {
      throw new Error('agent-codex Chat Completions adapter cannot represent a Responses reasoning history item')
    }
    if (record.type !== 'message' && record.type !== undefined) {
      throw new Error(`agent-codex Chat Completions adapter cannot represent input item ${JSON.stringify(record.type)}`)
    }
    if (record.role !== 'system' && record.role !== 'developer'
      && record.role !== 'user' && record.role !== 'assistant') {
      throw new Error(`agent-codex Chat Completions adapter does not support role ${JSON.stringify(record.role)}`)
    }
    messages.push({ role: record.role, content: chatContent(record.content, record.role, supportsImage) })
  }
  return messages
}

function chatTools(body: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  if (body.tools === undefined) return undefined
  if (!Array.isArray(body.tools)) throw new Error('agent-codex gateway tools must be an array')
  const tools: Array<Record<string, unknown>> = []
  const names = new Set<string>()
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
    if (record.type !== 'function' || typeof record.name !== 'string' || record.name.length === 0) {
      throw new Error(`agent-codex Chat Completions adapter does not support tool ${JSON.stringify(record.type)}`)
    }
    if (names.has(record.name)) throw new Error(`agent-codex Chat Completions adapter found duplicate tool ${JSON.stringify(record.name)}`)
    names.add(record.name)
    if (record.strict !== undefined && typeof record.strict !== 'boolean') {
      throw new Error(`agent-codex Chat Completions tool ${record.name} has invalid strict`)
    }
    if (record.parameters === null || typeof record.parameters !== 'object' || Array.isArray(record.parameters)) {
      throw new Error(`agent-codex Chat Completions tool ${record.name} has invalid parameters`)
    }
    tools.push({ type: 'function', function: {
      name: record.name,
      description: [namespace === undefined ? undefined : `Namespace: ${namespace}.`, record.description]
        .filter(value => typeof value === 'string').join(' '),
      parameters: record.parameters,
      strict: record.strict ?? false,
    } })
  }
  for (const tool of body.tools) append(tool)
  return tools
}

function chatToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (choice !== null && typeof choice === 'object') {
    const record = choice as Record<string, unknown>
    if (record.type === 'function' && typeof record.name === 'string') {
      return { type: 'function', function: { name: record.name } }
    }
  }
  throw new Error('agent-codex Chat Completions adapter does not support this tool_choice')
}

function chatRequestFields(body: Record<string, unknown>, supportsImage: boolean): Record<string, unknown> {
  const tools = chatTools(body)
  const toolChoice = chatToolChoice(body.tool_choice)
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    throw new Error('agent-codex Chat Completions adapter requires boolean parallel_tool_calls')
  }
  return {
    messages: chatMessages(body, supportsImage),
    ...tools === undefined ? {} : { tools },
    ...toolChoice === undefined ? {} : { tool_choice: toolChoice },
    ...body.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: body.parallel_tool_calls },
  }
}

function toolCallId(value: unknown): ToolCallId {
  if (typeof value !== 'string' || value.length === 0) throw new Error('agent-codex gateway tool call has no call_id')
  return brandString<ToolCallId>(value)
}

function messagesOf(body: Record<string, unknown>, route: Route): Message[] {
  if (typeof body.input === 'string') {
    return [createUserMessage({ content: textParts(body.input), source: { kind: 'user' } })]
  }
  if (!Array.isArray(body.input)) throw new Error('agent-codex gateway request input must be an array or string')
  const messages: Message[] = []
  for (const item of body.input) {
    if (item === null || typeof item !== 'object') throw new Error('agent-codex gateway received an invalid input item')
    const record = item as Record<string, unknown>
    if (record.type === 'reasoning') {
      throw new Error('agent-codex Chat Completions adapter cannot represent a Responses reasoning history item')
    }
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
      if (record.output === undefined) throw new Error('agent-codex gateway function_call_output has no output')
      const output = typeof record.output === 'string' ? record.output
        : Array.isArray(record.output) ? chatText(record.output)
          : JSON.stringify(record.output)
      messages.push(createToolResultMessage({
        callId: toolCallId(record.call_id),
        content: [{ type: 'text', text: output }],
        isError: false,
      }))
      continue
    }
    if (record.type !== 'message' && record.type !== undefined) {
      throw new Error(`agent-codex gateway does not support input item ${JSON.stringify(record.type)}`)
    }
    const content = record.content === null ? [] : piContextParts(record.content)
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
      throw new Error(`agent-codex Chat Completions adapter does not support tool ${JSON.stringify(record.type)}`)
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
  request?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: null,
    instructions: request?.instructions ?? null,
    max_output_tokens: request?.max_output_tokens ?? null,
    max_tool_calls: null,
    model,
    output,
    parallel_tool_calls: request?.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: request?.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: request?.tool_choice ?? 'auto',
    tools: request?.tools ?? [],
    top_p: null,
    truncation: 'disabled',
    usage: usage ?? null,
    metadata: {},
  }
}

async function streamAsResponses(
  response: ServerResponse,
  stream: AsyncIterable<StreamChunk>,
  model: string,
  requestBody: Record<string, unknown>,
  auditResult: (payload: JsonValue) => Promise<void>,
  signal: AbortSignal,
  requestLog?: GatewayRequestLog,
): Promise<void> {
  const emit = async (event: Record<string, unknown>): Promise<void> => {
    const data = `data: ${JSON.stringify(event)}\n\n`
    requestLog?.appendOutput(data)
    await writeDownstream(response, data, signal)
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
    | { id: string; outputIndex: number; kind: 'reasoning'; text: string }
    | { id: string; outputIndex: number; kind: 'tool'; callId: string; name: string; arguments: string }
  >()
  let nextOutputIndex = 0
  let usage: Record<string, unknown> | undefined
  let finished = false
  const failed = async (code: string, message: string): Promise<void> => {
    const event = {
      type: 'response.failed',
      response: { ...responseObject(responseId, model, output.filter(item => item !== undefined), usage, requestBody),
        status: 'failed', error: { code, message } },
    }
    await auditResult(event)
    await emit(event)
    end()
  }
  const responseHeaders = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': responseId,
  }
  requestLog?.recordOutputHeaders(200, responseHeaders)
  response.writeHead(200, responseHeaders)
  await emit({ type: 'response.created', response: { ...responseObject(responseId, model, [], undefined, requestBody), status: 'in_progress' } })
  try {
    for await (const chunk of stream) {
      if (chunk.type === 'block-start' && chunk.blockType === 'text') {
        const id = `msg_${randomUUID()}`
        const outputIndex = nextOutputIndex++
        states.set(chunk.index, { id, outputIndex, kind: 'text', text: '' })
        await emit({
          type: 'response.output_item.added', output_index: outputIndex,
          item: { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        })
        await emit({
          type: 'response.content_part.added', item_id: id, output_index: outputIndex, content_index: 0,
          part: { type: 'output_text', annotations: [], logprobs: [], text: '' },
        })
      } else if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
        const id = `rs_${randomUUID()}`
        const outputIndex = nextOutputIndex++
        states.set(chunk.index, { id, outputIndex, kind: 'reasoning', text: '' })
        await emit({ type: 'response.output_item.added', output_index: outputIndex,
          item: { id, type: 'reasoning', summary: [], content: [], encrypted_content: null } })
      } else if (chunk.type === 'text-delta') {
        const state = states.get(chunk.index)
        if (state?.kind !== 'text') throw new Error('agent-codex gateway received text outside a text block')
        state.text += chunk.text
        await emit({
          type: 'response.output_text.delta', item_id: state.id, output_index: state.outputIndex,
          content_index: 0, delta: chunk.text, logprobs: [],
        })
      } else if (chunk.type === 'reasoning-delta') {
        const state = states.get(chunk.index)
        if (state?.kind !== 'reasoning') throw new Error('agent-codex gateway received reasoning outside a reasoning block')
        state.text += chunk.text
        await emit({ type: 'response.reasoning_text.delta', item_id: state.id, output_index: state.outputIndex,
          content_index: 0, delta: chunk.text })
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
          await emit({
            type: 'response.output_item.added', output_index: state.outputIndex,
            item: { id: state.id, type: 'function_call', status: 'in_progress', name: state.name, arguments: '', call_id: state.callId },
          })
        }
        if (state.kind !== 'tool') throw new Error('agent-codex gateway received tool arguments outside a tool block')
        state.arguments += chunk.argumentsDelta
        await emit({
          type: 'response.function_call_arguments.delta', item_id: state.id,
          output_index: state.outputIndex, delta: chunk.argumentsDelta,
        })
      } else if (chunk.type === 'block-end') {
        let state = states.get(chunk.index)
        if (state === undefined && chunk.block.type === 'tool-call') {
          state = { id: `fc_${randomUUID()}`, outputIndex: nextOutputIndex++, kind: 'tool',
            callId: String(chunk.block.id), name: chunk.block.name, arguments: chunk.block.arguments }
          states.set(chunk.index, state)
          await emit({ type: 'response.output_item.added', output_index: state.outputIndex,
            item: { id: state.id, type: 'function_call', status: 'in_progress',
              name: state.name, arguments: '', call_id: state.callId } })
          await emit({ type: 'response.function_call_arguments.delta', item_id: state.id,
            output_index: state.outputIndex, delta: state.arguments })
        }
        if (state?.kind === 'text') {
          const part = { type: 'output_text', annotations: [], logprobs: [], text: state.text }
          const item = { id: state.id, type: 'message', status: 'completed', role: 'assistant', content: [part] }
          await emit({ type: 'response.output_text.done', item_id: state.id, output_index: state.outputIndex, content_index: 0, text: state.text, logprobs: [] })
          await emit({ type: 'response.content_part.done', item_id: state.id, output_index: state.outputIndex, content_index: 0, part })
          await emit({ type: 'response.output_item.done', output_index: state.outputIndex, item })
          output[state.outputIndex] = item
        } else if (state?.kind === 'reasoning') {
          const item = { id: state.id, type: 'reasoning', summary: [],
            content: [{ type: 'reasoning_text', text: state.text }], encrypted_content: null }
          await emit({ type: 'response.output_item.done', output_index: state.outputIndex, item })
          output[state.outputIndex] = item
        } else if (state?.kind === 'tool') {
          const item = { id: state.id, type: 'function_call', status: 'completed', name: state.name, arguments: state.arguments, call_id: state.callId }
          await emit({ type: 'response.function_call_arguments.done', item_id: state.id, output_index: state.outputIndex, arguments: state.arguments })
          await emit({ type: 'response.output_item.done', output_index: state.outputIndex, item })
          output[state.outputIndex] = item
        } else throw new Error(`agent-codex gateway received unrecognized block end ${chunk.index}`)
      } else if (chunk.type === 'usage') {
        usage = {
          input_tokens: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0),
          input_tokens_details: { cached_tokens: chunk.usage.cacheReadTokens ?? 0 },
          output_tokens: chunk.usage.outputTokens,
          output_tokens_details: { reasoning_tokens: chunk.usage.reasoningTokens ?? 0 },
          total_tokens: chunk.usage.totalTokens ?? chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0)
          + (chunk.usage.cacheWriteTokens ?? 0) + chunk.usage.outputTokens,
        }
      } else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        finished = true
        await failed(chunk.reason.failure.code, chunk.reason.failure.message)
        return
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'max-tokens') {
        finished = true
        const event = { type: 'response.incomplete', response: {
          ...responseObject(responseId, model, output.filter(item => item !== undefined), usage, requestBody),
          status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        } }
        await auditResult(event)
        await emit(event)
        end()
        return
      } else if (chunk.type === 'block-start' && chunk.blockType !== 'tool-call') {
        throw new Error(`agent-codex gateway cannot represent output block ${JSON.stringify(chunk.blockType)}`)
      } else if (chunk.type === 'finish') {
        finished = true
      }
    }
    if (!finished) throw new Error('agent-codex Chat Completions stream ended without a terminal finish')
  } catch (cause) {
    if (signal.aborted || response.destroyed) throw cause
    const code = cause !== null && typeof cause === 'object' && 'code' in cause
      && typeof cause.code === 'string' ? cause.code : 'MODEL_STREAM_ERROR'
    await failed(code, cause instanceof Error ? cause.message : String(cause))
    return
  }
  const event = {
    type: 'response.completed',
    response: responseObject(responseId, model, output.filter(item => item !== undefined), usage, requestBody),
  }
  await auditResult(event as unknown as JsonValue)
  await emit(event)
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
  /** Random bearer token accepted only by this local gateway generation. */
  readonly token = randomUUID()
  /** Address available after the local HTTP listener starts. */
  readonly ready: Promise<string>
  private readonly server: Server
  private auditFailure: Error | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: () => CodexModelGatewayConfig,
    private readonly authorize: CodexGatewayRequestAuthorizer,
    private readonly audit: CodexGatewayAuditWriter,
    private readonly env: Readonly<Record<string, string>> = {},
    private readonly requestLogDir?: string,
  ) {
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

  /** Describe configured route authentication without resolving a secret or calling upstream.
   * @param model - exact configured gateway model id.
   * @returns local key presence, or provider-managed when no key reference is named.
   */
  async describeAuthentication(model: string): Promise<LlmAuthenticationInfo> {
    const config = this.config()
    const route = resolveRoute(config, model)
    const profile = providerProfiles(config)[route.provider]
    if (profile === undefined) throw new Error('agent-codex gateway provider is not configured')
    const ref = profile.apiKeyEnv
    if (ref === undefined) return { status: 'provider-managed' }
    const credentials = this.ctx.get('credentials')
    const configured = credentials === undefined
      ? ((this.env[ref] ?? process.env[ref])?.length ?? 0) > 0
      : (await credentials.describe(credentialRef(ref))).configured
    return { status: configured ? 'configured' : 'missing', reference: ref }
  }

  /** Stop accepting calls and abort all loopback connections. */
  async dispose(): Promise<void> {
    await closeServer(this.server)
  }

  private async writeAudit(binding: CodexGatewayRequestBinding, entry: CodexGatewayAuditEntry): Promise<void> {
    if (this.auditFailure !== undefined) throw this.auditFailure
    try {
      await this.audit(binding, entry)
    } catch (cause) {
      this.auditFailure = cause instanceof Error ? cause : new Error(String(cause))
      throw this.auditFailure
    }
  }

  private auditedFetch(binding: CodexGatewayRequestBinding, route: Route & { readonly apiFormat: CodexApiFormat }): typeof fetch {
    let upstreamAttempt = 0
    return async (input, init) => {
      const request = new Request(input, init)
      const index = ++upstreamAttempt
      const rawBody = await request.clone().text()
      await this.writeAudit(binding, { phase: 'upstream-request', payload: {
        index, method: request.method, url: request.url,
        route: { provider: route.provider, model: route.model, apiFormat: route.apiFormat },
        headers: safeTransportHeaders(request.headers), rawBody,
      } })
      let upstream: Response
      try {
        upstream = await fetch(request)
      } catch (cause) {
        await this.writeAudit(binding, { phase: 'failure', payload: {
          index, message: cause instanceof Error ? cause.message : String(cause),
        } })
        throw cause
      }
      await this.writeAudit(binding, { phase: 'upstream-response', payload: {
        index, status: upstream.status, headers: safeTransportHeaders(upstream.headers),
      } })
      if (upstream.body === null) {
        await this.writeAudit(binding, { phase: 'upstream-end', payload: { index, complete: true } })
        return upstream
      }
      const reader = upstream.body.getReader()
      const stream = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            const next = await reader.read()
            if (next.done) {
              await this.writeAudit(binding, { phase: 'upstream-end', payload: { index, complete: true } })
              controller.close()
              return
            }
            await this.writeAudit(binding, { phase: 'upstream-chunk', payload: {
              index, base64: Buffer.from(next.value).toString('base64'),
            } })
            controller.enqueue(next.value)
          } catch (cause) {
            if (this.auditFailure === undefined) {
              const failureRecorded = await this.writeAudit(binding, { phase: 'failure', payload: {
                index, message: cause instanceof Error ? cause.message : String(cause),
              } }).then(() => true, () => false)
              if (failureRecorded) {
                await this.writeAudit(binding, { phase: 'upstream-end', payload: { index, complete: false } })
              }
            }
            void reader.cancel(cause).catch(() => {})
            controller.error(cause)
          }
        },
        cancel: async (reason) => {
          try { await reader.cancel(reason) } finally {
            await this.writeAudit(binding, { phase: 'upstream-end', payload: { index, complete: false } })
          }
        },
      })
      return new Response(stream, {
        status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
      })
    }
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
      if (this.auditFailure !== undefined) throw this.auditFailure
      const received = await readBody(request)
      const body = received.parsed
      const metadata = requestMetadata(request, body)
      const authorized = this.authorize(metadata)
      if (authorized === undefined) throw new Error('agent-codex gateway request does not belong to an active DSH turn')
      const binding: CodexGatewayRequestBinding = { ...metadata, ...authorized }
      await this.writeAudit(binding, { phase: 'original-request', payload: {
        method: request.method ?? '', url: request.url ?? '', headers: loggedHeaders(request), rawBody: received.raw,
      } })
      if (this.requestLogDir !== undefined) {
        requestLog = await GatewayRequestLog.create(this.requestLogDir, request, body, binding)
      }
      // One settings snapshot owns route, format, endpoint, and model for this attempt.
      // The next Codex retry reads settings again instead of mutating an active call.
      const config = structuredClone(this.config())
      const route = resolveRoute(config, body.model)
      const supportsImage = modelSupportsImage(config, route)
      assertDeclaredImageInput(body, supportsImage)
      const controller = new AbortController()
      response.on('close', () => { controller.abort('Codex gateway client disconnected') })
      const profile = providerProfiles(config)[route.provider]
      if (profile === undefined) throw new Error(`agent-codex gateway provider ${JSON.stringify(route.provider)} is not configured`)
      const apiFormat: CodexApiFormat = profile.apiFormat === 'responses' ? 'responses' : 'chat-completions'
      const signal = profile.timeoutMs === undefined || profile.timeoutMs === 0
        ? controller.signal
        : AbortSignal.any([controller.signal, AbortSignal.timeout(profile.timeoutMs)])
      const requestFetch = this.auditedFetch(binding, { ...route, apiFormat })
      if (apiFormat === 'responses') {
        await this.proxyResponses(response, body, route, profile, signal, requestFetch, requestLog)
        return
      }
      const translated = chatRequestFields(body, supportsImage)
      const chatFetch: typeof fetch = async (input, init) => {
        const original = new Request(input, init)
        const originalBody: unknown = await original.clone().json()
        if (originalBody === null || typeof originalBody !== 'object' || Array.isArray(originalBody)) {
          throw new Error('agent-codex Chat Completions adapter created an invalid request body')
        }
        const headers = new Headers(original.headers)
        headers.delete('content-length')
        return requestFetch(new Request(original, {
          headers, body: JSON.stringify({ ...originalBody, ...translated }),
        }))
      }
      const adapter = new PiAiAdapter({
        profiles: () => resolveProfiles(translatedProfiles(config)),
        resolveApiKey: async (_provider, resolved) => this.resolveApiKey(resolved.apiKeyEnv),
        auth: { credentials: credentialStoreFrom(this.ctx), authContext: authContextFrom(this.ctx) },
      })
      await streamAsResponses(
        response, adapter.streamWithFetch(generateOptions(body, route, signal), chatFetch),
        String(body.model), body, payload => this.writeAudit(binding, { phase: 'result', payload }), signal, requestLog,
      )
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
    requestFetch: typeof fetch,
    requestLog?: GatewayRequestLog,
  ): Promise<void> {
    if (profile.baseURL === undefined) {
      throw new Error(`agent-codex native Responses provider ${JSON.stringify(route.provider)} requires baseURL`)
    }
    const apiKey = await this.resolveApiKey(profile.apiKeyEnv)
    const upstream = await requestFetch(`${profile.baseURL.replace(/\/$/, '')}/responses`, {
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
    let complete = false
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) { complete = true; break }
        requestLog?.appendOutput(chunk.value)
        await writeDownstream(response, chunk.value, signal)
      }
      response.end()
    } finally {
      if (!complete) await reader.cancel('Codex gateway stream interrupted').catch(() => {})
      reader.releaseLock()
    }
  }
}
