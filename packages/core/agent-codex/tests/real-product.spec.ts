import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { prepareAgentTransfer } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import CodexAgentProvider, { CODEX_PROTOCOL_VERSION } from '../src/index.ts'
import type { CodexImportPreparation } from '../src/portable-target.ts'
import { CodexAuditReceiver } from '../src/audit-receiver.ts'

const codexTestBinary = process.env.DSH_CODEX_TEST_BIN

const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close((cause) => { if (cause === undefined) resolve(); else reject(cause) })
    server.closeAllConnections()
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}, 30_000)

function responseEvents(text: string): readonly Record<string, unknown>[] {
  const part = { type: 'output_text', annotations: [], logprobs: [], text }
  const message = {
    id: 'msg_dsh_fixture', type: 'message', status: 'completed', role: 'assistant', content: [part],
  }
  const completed = {
    id: 'resp_dsh_fixture', object: 'response', created_at: 1, status: 'completed',
    background: false, error: null, incomplete_details: null, instructions: null,
    max_output_tokens: null, max_tool_calls: null, model: 'fixture-model', output: [message],
    parallel_tool_calls: true, previous_response_id: null, prompt_cache_key: 'dsh-fixture',
    prompt_cache_retention: null, reasoning: { effort: null, summary: null },
    safety_identifier: null, service_tier: 'default', store: false, temperature: null,
    text: { format: { type: 'text' }, verbosity: 'medium' }, tool_choice: 'auto', tools: [],
    top_logprobs: 0, top_p: null, truncation: 'disabled', user: null, metadata: {},
    usage: {
      input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11,
    },
  }
  return [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added', output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added', item_id: message.id, output_index: 0,
      content_index: 0, part: { ...part, text: '' },
    },
    {
      type: 'response.output_text.delta', item_id: message.id, output_index: 0,
      content_index: 0, delta: text, logprobs: [],
    },
    {
      type: 'response.output_text.done', item_id: message.id, output_index: 0,
      content_index: 0, text, logprobs: [],
    },
    { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: completed },
  ]
}

function dynamicToolCallEvents(tool: { name: string; arguments: string }): readonly Record<string, unknown>[] {
  const base = responseEvents('unused')
  const created = base[0] as { type: string; response: Record<string, unknown> }
  const completed = base.at(-1) as { type: string; response: Record<string, unknown> }
  const item = { id: 'fc_dsh_fixture', type: 'function_call', status: 'completed',
    call_id: 'call_dsh_fixture', ...tool }
  return [
    created,
    { type: 'response.output_item.added', output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id,
      delta: item.arguments },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id,
      arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...completed.response, output: [item] } },
  ]
}

async function startResponses(
  texts: readonly string[], failFirst: boolean = false,
  toolCall?: { name: string; arguments: string },
): Promise<{
  baseUrl: string
  requests: Record<string, unknown>[]
  rawRequests: string[]
}> {
  const requests: Record<string, unknown>[] = []
  const rawRequests: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      const text = texts[requests.length - Number(failFirst)]
      if (failFirst && requests.length === 0) {
        requests.push(parsed)
        rawRequests.push(body)
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"fixture retry"}}')
        return
      }
      if (text === undefined) {
        response.writeHead(500)
        response.end('unexpected Responses request')
        return
      }
      requests.push(parsed)
      rawRequests.push(body)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const event of toolCall !== undefined && requests.length === 1
        ? dynamicToolCallEvents(toolCall) : responseEvents(text)) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing fixture address')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, rawRequests }
}

async function startChatCompletions(texts: readonly string[], inputTokens: readonly number[] = []): Promise<{
  baseUrl: string
  requests: Record<string, unknown>[]
}> {
  const requests: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const text = texts[requests.length]
      if (request.url !== '/v1/chat/completions' || text === undefined) {
        response.writeHead(500)
        response.end('unexpected Chat Completions request')
        return
      }
      requests.push(JSON.parse(body) as Record<string, unknown>)
      const promptTokens = inputTokens[requests.length - 1] ?? 10
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl_dsh_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl_dsh_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing fixture address')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

describe.skipIf(codexTestBinary === undefined)('real fork Codex app-server agent', () => {
  it.each([false, true])('transfers Codex context without the old CODEX_HOME and resumes the new Session (missing workspace: %s)', async (missingWorkspace) => {
    const fixture = await startChatCompletions([
      'FIRST_CONTEXT', 'SECOND_CONTEXT', 'SOURCE_CONTINUATION', 'IMPORTED_CONTINUATION', 'RESUMED_CONTINUATION',
    ])
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-transfer-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const oldHome = join(root, 'codex-old')
    const newHome = join(root, 'codex-new')
    mkdirSync(workspace)
    mkdirSync(oldHome)
    mkdirSync(newHome)
    for (const home of [oldHome, newHome]) {
      const skillRoot = join(home, 'skills', 'native-skill-sentinel')
      mkdirSync(skillRoot, { recursive: true })
      await writeFile(join(skillRoot, 'SKILL.md'), [
        '---', 'name: native-skill-sentinel', 'description: NATIVE_SKILL_CATALOG_SENTINEL',
        '---', 'NATIVE_SKILL_BODY_SENTINEL', '',
      ].join('\n'))
    }
    const install = async (codexHome: string): Promise<Context> => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
      await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(ApprovalService, { policy: 'never' })
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(CodexAgentProvider, {
        binaryPath: codexTestBinary ?? '/missing-dsh-codex-test-binary',
        runtimeRevision: 'test-fork', cwd: root, approvalPolicy: 'never', turnTimeoutMs: 20_000,
        providers: { fixture: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: fixture.baseUrl,
          models: [{ id: 'fixture-model' }] } },
        env: { CODEX_HOME: codexHome, DSH_CODEX_REVISION: 'stale-overlay', OPENAI_API_KEY: 'fixture-key', HOME: root,
          HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' },
      })
      return ctx
    }
    const send = async (agent: import('@deepseek-ai/dsh-agent').Agent, text: string): Promise<void> => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
      const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      expect(end?.type === 'turn/end' ? end.data.reason : undefined).toEqual({ kind: 'completed' })
    }
    const sourceId = SessionId('codex-transfer-source')
    const targetId = SessionId('codex-transfer-target')
    const model = { provider: 'codex:fixture', id: 'fixture/fixture-model' }
    const agentOptions = { provider: model.provider, model: model.id }
    const sourceCtx = await install(oldHome)
    const source = await sourceCtx.agents.create({ sessionId: sourceId, meta: { cwd: workspace },
      agentOptions })
    await send(source.agent, 'Remember the first context.')
    await send(source.agent, 'Remember the second context.')
    const sourceThread = sourceCtx.sessionProjections.stateOf(source.agent.session, 'codexThreadBinding')?.binding?.threadId
    expect(sourceThread).toBeDefined()
    const ports = sourceCtx.agents.getTransferPorts('codex')
    const reviewed = await prepareAgentTransfer(ports.source, ports.target, sourceId, targetId, model)
    expect(reviewed.assessment).toEqual({ fidelity: 'same-driver', issues: [] })
    const preparation = await reviewed.commit(false) as CodexImportPreparation
    await send(source.agent, 'Continue from the saved context.')
    const sourceNextRequest = fixture.requests.at(-1)
    await source.dispose()
    await sourceCtx.fiber.dispose()
    await rm(oldHome, { recursive: true })
    expect(existsSync(oldHome)).toBe(false)
    if (missingWorkspace) await rm(workspace, { recursive: true })
    const requestsBeforeImport = fixture.requests.length

    const targetCtx = await install(newHome)
    const imported = await targetCtx.agents.getTransferPorts('codex').target.createImportedAgent(preparation, { cwd: workspace })
    expect(fixture.requests).toHaveLength(requestsBeforeImport)
    expect(imported.agent.session.header.cwd).toBe(workspace)
    expect(existsSync(workspace)).toBe(!missingWorkspace)
    if (missingWorkspace) mkdirSync(workspace)
    const newThread = targetCtx.sessionProjections.stateOf(imported.agent.session, 'codexThreadBinding')?.binding?.threadId
    expect(newThread).toBeDefined()
    expect(newThread).not.toBe(sourceThread)
    expect(imported.agent.session.header.importLineage).toMatchObject({
      sourceSessionId: sourceId, sourceDriverId: 'codex', importId: reviewed.lineage.importId,
    })
    await send(imported.agent, 'Continue from the saved context.')
    const importedRequest = fixture.requests.at(-1)
    expect(importedRequest?.messages).toEqual(sourceNextRequest?.messages)
    expect(importedRequest?.tools).toEqual(sourceNextRequest?.tools)
    await imported.dispose()
    await targetCtx.fiber.dispose()

    const resumedCtx = await install(newHome)
    const resumed = await resumedCtx.agents.resume({ resumeSessionId: targetId, agentOptions })
    expect(resumedCtx.sessionProjections.stateOf(resumed.agent.session, 'codexThreadBinding')?.binding?.threadId)
      .toBe(newThread)
    await send(resumed.agent, 'Continue after the DSH restart.')
    expect(fixture.requests).toHaveLength(5)
    expect(fixture.requests.at(-1)?.messages).toEqual([
      ...importedRequest?.messages as unknown[],
      { role: 'assistant', content: 'IMPORTED_CONTINUATION' },
      { role: 'user', content: 'Continue after the DSH restart.' },
    ])
    expect(fixture.requests.at(-1)?.tools).toEqual(importedRequest?.tools)
    const resumedPorts = resumedCtx.agents.getTransferPorts('codex')
    const reexport = await prepareAgentTransfer(resumedPorts.source, resumedPorts.target,
      targetId, SessionId('codex-transfer-reexport'), model)
    expect(reexport.assessment).toEqual({ fidelity: 'same-driver', issues: [] })
    const reexported = await reexport.commit(false) as CodexImportPreparation
    expect(reexported.lineage.sourceSessionId).toBe(targetId)
    expect(JSON.stringify(reexported.context.items)).toContain('FIRST_CONTEXT')
    expect(JSON.stringify(reexported.context.items)).toContain('IMPORTED_CONTINUATION')
    expect(JSON.stringify(reexported.context.items)).toContain('RESUMED_CONTINUATION')
    for (const request of fixture.requests) {
      const prompt = JSON.stringify(request.messages)
      expect(prompt).not.toContain('NATIVE_SKILL_CATALOG_SENTINEL')
      expect(prompt).not.toContain('NATIVE_SKILL_BODY_SENTINEL')
      expect(prompt).not.toContain('Available skills')
      expect(prompt).not.toContain(join(oldHome, 'skills'))
      expect(prompt).not.toContain(join(newHome, 'skills'))
    }
    const answer = resumed.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    expect(answer?.type === 'assistant/message' ? answer.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'RESUMED_CONTINUATION' }])
    await resumed.dispose()
  }, 120_000)

  for (const apiFormat of ['chat-completions', 'responses'] as const) it(`owns a complete DSH turn through ${apiFormat}`, async () => {
    const appendAudit = vi.spyOn(CodexAuditReceiver.prototype, 'append')
    const sentinels = ['REAL_AGENT_CODEX_SENTINEL_1', 'REAL_AGENT_CODEX_SENTINEL_2'] as const
    const fixture = apiFormat === 'responses'
      ? await startResponses(sentinels, true)
      : await startChatCompletions(sentinels)
    const root = mkdtempSync(join(tmpdir(), 'dsh-agent-codex-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const codexHome = join(root, 'codex-home')
    mkdirSync(workspace)
    mkdirSync(codexHome)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register({
      name: 'dsh_fixture_tool', description: 'Fixture tool owned by DSH',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'fixture-result',
    })
    await ctx.plugin(ApprovalService, { policy: 'never' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CodexAgentProvider, {
      binaryPath: codexTestBinary ?? '/missing-dsh-codex-test-binary',
      runtimeRevision: 'test-fork',
      cwd: workspace,
      approvalPolicy: 'never',
      disposeGraceMs: 2_000,
      turnTimeoutMs: 20_000,
      providers: {
        fixture: {
          apiKeyEnv: 'OPENAI_API_KEY',
          apiFormat,
          baseURL: fixture.baseUrl,
          models: [{ id: 'fixture-model' }],
        },
      },
      env: {
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: 'fixture-key',
        HOME: root,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        NO_PROXY: '127.0.0.1,localhost',
      },
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'codex:fixture', displayName: 'codex: fixture', settingsNs: 'codex',
      settingsPath: ['providers', 'fixture'], declared: true,
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('real-agent-codex'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'codex' },
    })
    for (const [index, prompt] of ['Return the first sentinel.', 'Return the second sentinel.'].entries()) {
      if (index === 1) ctx.tools.register({
        name: 'dsh_added_tool', description: 'Added after the first turn',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        execute: async () => 'added-result',
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
    }

    const assistant = handle.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' ? assistant.data.message.content : undefined,
      JSON.stringify(handle.agent.session.snapshotEvents()
        .filter(event => event.type === 'codex/error' || event.type === 'turn/end')
        .map(event => ({ type: event.type, data: event.data }))))
      .toEqual([{ type: 'text', text: sentinels[1] }])
    const expectedAttempts = apiFormat === 'responses' ? 3 : 2
    expect(fixture.requests).toHaveLength(expectedAttempts)
    expect(JSON.stringify(fixture.requests[0])).toContain(
      'Tool execution for this session is delegated to DeepSeek Harness (DSH).',
    )
    expect(JSON.stringify(fixture.requests.at(-1))).toContain(
      'Tool execution for this session is delegated to DeepSeek Harness (DSH).',
    )
    const audit = handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'codex/model-audit')
      .map(event => event.data)
    const attempts = [...new Set(audit.map(event => event.attemptId))]
    expect(attempts).toHaveLength(expectedAttempts)
    expect(audit.filter(event => event.phase === 'original-request')).toHaveLength(expectedAttempts)
    expect(audit.filter(event => event.phase === 'upstream-request')).toHaveLength(expectedAttempts)
    expect(audit.filter(event => event.phase === 'upstream-end')).toHaveLength(expectedAttempts)
    for (const attemptId of attempts) {
      const attempt = audit.filter(event => event.attemptId === attemptId)
      expect(attempt[0]?.phase).toBe('original-request')
      expect((attempt[0]?.payload as { headers: Record<string, string> }).headers['x-dsh-model-attempt-id'])
        .toBe(attemptId)
      expect(attempt[1]?.phase).toBe('upstream-request')
      expect(attempt.at(-1)?.phase).toBe(apiFormat === 'responses' ? 'upstream-end' : 'result')
      expect(attempt.every(event => event.purpose === 'inference')).toBe(true)
    }
    if (apiFormat === 'responses' && 'rawRequests' in fixture) {
      for (const [index, attemptId] of attempts.entries()) {
        const events = audit.filter(event => event.attemptId === attemptId)
        const original = events.find(event => event.phase === 'original-request')
        const upstream = events.find(event => event.phase === 'upstream-request')
        const codexBody = JSON.parse((original?.payload as { rawBody: string }).rawBody) as Record<string, unknown>
        const routedBody = JSON.parse((upstream?.payload as { rawBody: string }).rawBody) as Record<string, unknown>
        expect(routedBody).toEqual({ ...codexBody, model: 'fixture-model' })
        expect((upstream?.payload as { rawBody: string }).rawBody).toBe((fixture.rawRequests as string[])[index])
        expect(routedBody).toEqual(fixture.requests[index])
      }
      expect(fixture.requests[0]?.prompt_cache_key).toBeTypeOf('string')
      expect(fixture.requests[1]?.prompt_cache_key).toBe(fixture.requests[0]?.prompt_cache_key)
      expect(fixture.requests[1]?.tools).toEqual(fixture.requests[0]?.tools)
      expect(fixture.requests[1]?.instructions).toEqual(fixture.requests[0]?.instructions)
    } else {
      expect(fixture.requests[0]?.model).toBe('fixture-model')
      expect(fixture.requests[0]?.tools).toBeInstanceOf(Array)
    }
    const namesOf = (request: Record<string, unknown> | undefined): string[] =>
      (request?.tools as Array<{ name?: string; function?: { name: string } }> | undefined)
        ?.map(tool => tool.name ?? tool.function?.name ?? '') ?? []
    expect(namesOf(fixture.requests[0])).toEqual(['dsh_fixture_tool'])
    expect(namesOf(fixture.requests.at(-1))).toEqual(['dsh_added_tool', 'dsh_fixture_tool'])
    const catalogs = handle.agent.session.snapshotEvents().filter(event => event.type === 'codex/tool-catalog')
    expect(catalogs).toHaveLength(2)
    expect(catalogs[0]?.data.hash).not.toBe(catalogs[1]?.data.hash)
    const forkAudit = handle.agent.session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')
    expect(forkAudit.map(event => event.data.sequence)).toEqual(forkAudit.map((_event, index) => index + 1))
    expect(forkAudit.filter(event => event.data.kind === 'context/config')).toHaveLength(2)
    expect(forkAudit.filter(event => event.data.kind === 'checkpoint')).toHaveLength(2)
    expect(forkAudit.filter(event => event.data.kind === 'model/request')).toHaveLength(expectedAttempts)
    expect(forkAudit.filter(event => event.data.kind === 'model/result')).toHaveLength(2)
    expect(forkAudit.filter(event => event.data.kind === 'model/failure'))
      .toHaveLength(apiFormat === 'responses' ? 1 : 0)
    expect(appendAudit.mock.calls.map(([event]) => event)).toEqual(forkAudit.map(event => event.data))
    expect(await Promise.all(appendAudit.mock.results.map(result => result.value as ReturnType<CodexAuditReceiver['append']>)))
      .toEqual(forkAudit.map(({ data }) => ({ version: 1, sequence: data.sequence, eventId: data.eventId })))
    const binding = ctx.sessionProjections.stateOf(handle.agent.session, 'codexThreadBinding')
    expect(binding?.binding).toMatchObject({
      runtimeVersion: `protocol:${CODEX_PROTOCOL_VERSION};fork:test-fork`,
      cwd: workspace,
    })
    const auditThread = binding?.binding?.threadId
    expect(auditThread).toBeDefined()
    for (const { data } of forkAudit) {
      const path = join(codexHome, 'dsh-audit-v1', auditThread ?? '', `${String(data.sequence).padStart(20, '0')}.json`)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(data)
    }
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'This turn must stop before calling the model.' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(fixture.requests).toHaveLength(expectedAttempts)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'codex/audit-v1'))
      .toHaveLength(forkAudit.length + 1)
    expect(appendAudit.mock.calls).toHaveLength(forkAudit.length + 1)
    await expect(appendAudit.mock.results.at(-1)?.value).rejects.toThrow('durable Session audit storage is unavailable')
    await handle.dispose()
  }, 60_000)

  it('executes a real app-server dynamic tool through the audited DSH tool runtime', async () => {
    const fixture = await startResponses(['tool-call', 'FINAL_AFTER_DSH_TOOL'], false,
      { name: 'dsh_fixture_tool', arguments: '{"query":"x"}' })
    const root = mkdtempSync(join(tmpdir(), 'dsh-agent-codex-tool-call-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const codexHome = join(root, 'codex-home')
    mkdirSync(workspace)
    mkdirSync(codexHome)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const execute = vi.fn(async () => 'fixture-result')
    ctx.tools.register({ name: 'dsh_fixture_tool', description: 'Fixture DSH tool',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute,
    })
    await ctx.plugin(ApprovalService, { policy: 'never' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CodexAgentProvider, {
      binaryPath: codexTestBinary ?? '/missing-dsh-codex-test-binary', runtimeRevision: 'test-fork',
      cwd: workspace, approvalPolicy: 'never', turnTimeoutMs: 20_000,
      providers: { fixture: { apiKeyEnv: 'OPENAI_API_KEY', apiFormat: 'responses', baseURL: fixture.baseUrl,
        models: [{ id: 'fixture-model' }] } },
      env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'fixture-key', HOME: root,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' },
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('real-codex-tool-admission'), meta: { cwd: workspace },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the DSH fixture tool.' }],
      source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const events = handle.agent.session.snapshotEvents()
    const bound = events.filter(event => event.type === 'codex/tool-call-bound')
    expect(bound).toHaveLength(1)
    expect(bound[0]?.data).toMatchObject({ codexCallId: 'call_dsh_fixture', name: 'dsh_fixture_tool',
      arguments: { query: 'x' } })
    expect(bound[0]?.data.dshCallId).toMatch(/^codex_[0-9a-f]{64}$/)
    expect(execute).toHaveBeenCalledOnce()
    const call = events.find(event => event.type === 'tool/call')
    const result = events.find(event => event.type === 'tool/result')
    expect(call?.type === 'tool/call' ? call.data.callId : undefined).toBe(bound[0]?.data.dshCallId)
    expect(result?.type === 'tool/result' ? result.data.message.content[0] : undefined)
      .toMatchObject({ isError: false, content: [{ type: 'text', text: 'fixture-result' }] })
    expect(fixture.requests[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_dsh_fixture', output: 'fixture-result' }),
    ]))
    await handle.dispose()
  }, 60_000)

  it('rejects an unadvertised native command even when its Codex feature is enabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-agent-codex-native-denial-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const codexHome = join(root, 'codex-home')
    const marker = join(root, 'native-command-ran')
    mkdirSync(workspace)
    mkdirSync(codexHome)
    await writeFile(join(codexHome, 'config.toml'), 'features.shell_tool = true\n')
    const fixture = await startResponses(['ignored', 'FINAL_AFTER_DENIAL'], false,
      { name: 'exec_command', arguments: JSON.stringify({ cmd: `touch ${marker}` }) })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'never' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CodexAgentProvider, {
      binaryPath: codexTestBinary ?? '/missing-dsh-codex-test-binary', runtimeRevision: 'test-fork',
      cwd: workspace, approvalPolicy: 'never', turnTimeoutMs: 20_000,
      providers: { fixture: { apiKeyEnv: 'OPENAI_API_KEY', apiFormat: 'responses',
        baseURL: fixture.baseUrl, models: [{ id: 'fixture-model' }] } },
      env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'fixture-key', HOME: root,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' },
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('real-codex-native-denial'), meta: { cwd: workspace },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try the requested command.' }],
      source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(fixture.requests.map(request => request.tools)).toEqual([[], []])
    expect(fixture.requests[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_dsh_fixture' }),
    ]))
    expect(existsSync(marker)).toBe(false)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'codex/tool-call-bound')).toEqual([])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
    await handle.dispose()
  }, 60_000)

  it('routes automatic local compaction through the same audited DSH model executor', async () => {
    const fixture = await startChatCompletions(['VISIBLE_ANSWER', 'COMPACTED_CONTEXT'], [10_000, 10])
    const root = mkdtempSync(join(tmpdir(), 'dsh-agent-codex-compact-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const codexHome = join(root, 'codex-home')
    mkdirSync(workspace)
    mkdirSync(codexHome)
    await writeFile(join(codexHome, 'config.toml'), [
      'model_context_window = 20000',
      'model_post_turn_compact_threshold_percent = 1',
      '',
    ].join('\n'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh-home') })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'never' })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CodexAgentProvider, {
      binaryPath: codexTestBinary ?? '/missing-dsh-codex-test-binary',
      runtimeRevision: 'test-fork',
      cwd: workspace,
      approvalPolicy: 'never',
      turnTimeoutMs: 20_000,
      providers: { fixture: {
        apiKeyEnv: 'OPENAI_API_KEY', baseURL: fixture.baseUrl,
        models: [{ id: 'fixture-model' }],
      } },
      env: {
        CODEX_HOME: codexHome, OPENAI_API_KEY: 'fixture-key', HOME: root,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
      },
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('real-agent-codex-compaction'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Return the answer.' }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    const originalRequests = handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'codex/model-audit')
      .map(event => event.data)
      .filter(event => event.phase === 'original-request')
    expect(originalRequests.map(event => event.purpose)).toEqual(['inference', 'compaction'])
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]?.model).toBe('fixture-model')
    expect(JSON.stringify(fixture.requests[1])).toContain(
      'Tool execution for this session is delegated to DeepSeek Harness (DSH).',
    )
    await handle.dispose()
  }, 60_000)
})
