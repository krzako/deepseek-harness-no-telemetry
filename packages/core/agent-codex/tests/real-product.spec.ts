import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import CodexAgentProvider, { CODEX_PROTOCOL_VERSION } from '../src/index.ts'

const codexTestBinary = process.env.DSH_CODEX_TEST_BIN

const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
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

async function startResponses(texts: readonly string[]): Promise<{
  baseUrl: string
  requests: Record<string, unknown>[]
}> {
  const requests: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      const text = texts[requests.length]
      if (text === undefined) {
        response.writeHead(500)
        response.end('unexpected Responses request')
        return
      }
      requests.push(parsed)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const event of responseEvents(text)) response.write(`data: ${JSON.stringify(event)}\n\n`)
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests }
}

describe.skipIf(codexTestBinary === undefined)('real fork Codex app-server agent', () => {
  it('owns one complete DSH turn against a mock Responses API', async () => {
    const sentinels = ['REAL_AGENT_CODEX_SENTINEL_1', 'REAL_AGENT_CODEX_SENTINEL_2'] as const
    const fixture = await startResponses(sentinels)
    const root = mkdtempSync(join(tmpdir(), 'dsh-agent-codex-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const codexHome = join(root, 'codex-home')
    mkdirSync(workspace)
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, 'config.toml'), [
      'model = "fixture-model"',
      'model_provider = "fixture"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'disable_response_storage = false',
      'check_for_update_on_startup = false',
      '',
      '[model_providers.fixture]',
      'name = "DSH fixture"',
      `base_url = "${fixture.baseUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      '',
      '[analytics]',
      'enabled = false',
      '',
      '[features]',
      'plugins = false',
      '',
    ].join('\n'))

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
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
      sandbox: 'read-only',
      disposeGraceMs: 2_000,
      turnTimeoutMs: 20_000,
      env: {
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: 'fixture-key',
        HOME: root,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        NO_PROXY: '127.0.0.1,localhost',
      },
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('real-agent-codex'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'codex' },
    })
    for (const prompt of ['Return the first sentinel.', 'Return the second sentinel.']) {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
    }

    const assistant = handle.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' ? assistant.data.message.content : undefined)
      .toEqual([{ type: 'text', text: sentinels[1] }])
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[0]?.prompt_cache_key).toBeTypeOf('string')
    expect(fixture.requests[1]?.prompt_cache_key).toBe(fixture.requests[0]?.prompt_cache_key)
    expect(fixture.requests[1]?.tools).toEqual(fixture.requests[0]?.tools)
    expect(fixture.requests[1]?.instructions).toEqual(fixture.requests[0]?.instructions)
    const binding = ctx.sessionProjections.stateOf(handle.agent.session, 'codexThreadBinding')
    expect(binding?.binding).toMatchObject({
      runtimeVersion: `protocol:${CODEX_PROTOCOL_VERSION};fork:test-fork`,
      cwd: workspace,
    })
    await handle.dispose()
  }, 60_000)
})
