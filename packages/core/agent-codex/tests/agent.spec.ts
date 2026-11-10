import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { prepareAgentTransfer, type AgentDriverFactory,
  type AgentTransferSourcePort, type PortableAgentContextV1 } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import {
  CodexAgent,
  createCodexImportedAgent,
  codexPrivateSnapshot,
  type CodexContextSnapshotV2,
  codexThreadBindingProjectionDefinition,
  type CodexAppServer,
  type CodexNotification,
  type CodexUserInput,
  type CodexDynamicTool,
} from '../src/index.ts'
import { codexTransferTarget } from '../src/portable-target.ts'
import type { CodexAppServerSupervisor } from '../src/supervisor.ts'
import { MockAdapter, textResponse } from '../../agent-loop/tests/mock-adapter.ts'

class FakeAppServer implements CodexAppServer {
  private readonly listeners = new Set<(notification: CodexNotification) => void>()
  private threadCounter = 0
  private turnCounter = 0
  autoComplete = true
  initialize = vi.fn(async () => {})
  startThread = vi.fn(async () => `codex-thread-${++this.threadCounter}` as never)
  startThreadFromCheckpoint = vi.fn(async () => { throw new Error('unexpected checkpoint import') })
  resumeThread = vi.fn(async () => {})
  startTurn = vi.fn(async (
    threadId: string,
    _input: readonly CodexUserInput[],
    _signal?: AbortSignal,
    _effort?: string,
    _model?: string,
    _dynamicTools?: readonly CodexDynamicTool[],
  ) => {
    const turnId = `codex-turn-${++this.turnCounter}`
    if (this.autoComplete) queueMicrotask(() => { this.complete(turnId, threadId) })
    return { threadId, turnId } as never
  })
  complete(turnId: string, threadId = 'codex-thread-1'): void {
    this.emit('item/started', {
      threadId, turnId,
      item: { id: 'message-1', type: 'agentMessage', text: '' },
    })
    this.emit('item/completed', {
      threadId, turnId,
      item: { id: 'message-1', type: 'agentMessage', text: 'Codex answer', phase: 'final_answer' },
    })
    this.emit('thread/tokenUsage/updated', {
      threadId, turnId,
      tokenUsage: { last: {
        inputTokens: 7, cachedInputTokens: 3, cacheWriteInputTokens: 2,
        outputTokens: 5, reasoningOutputTokens: 1,
      } },
    })
    this.emit('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed' },
    })
  }
  resolveRequest(requestId: string, threadId = 'codex-thread-1'): void {
    this.emit('serverRequest/resolved', { threadId, requestId })
  }
  delta(
    method: 'item/agentMessage/delta' | 'item/reasoning/summaryTextDelta',
    turnId: string,
    delta: string,
    threadId = 'codex-thread-1',
  ): void {
    this.emit(method, { threadId, turnId, itemId: 'message-1', delta })
  }
  message(turnId: string, itemId: string, delta: string, text: string): void {
    this.emit('item/started', {
      threadId: 'codex-thread-1', turnId,
      item: { id: itemId, type: 'agentMessage', text: '' },
    })
    this.emit('item/agentMessage/delta', {
      threadId: 'codex-thread-1', turnId, itemId, delta,
    })
    this.emit('item/completed', {
      threadId: 'codex-thread-1', turnId,
      item: { id: itemId, type: 'agentMessage', text, phase: null },
    })
  }
  completeTurn(turnId: string): void {
    this.emit('turn/completed', {
      threadId: 'codex-thread-1', turn: { id: turnId, status: 'completed' },
    })
  }
  steerTurn = vi.fn(async () => {})
  interruptTurn = vi.fn(async () => {})
  subscribe(listener: (notification: CodexNotification) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  subscribeTurn(): () => void { return () => {} }
  close(): void {}
  private emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners) listener({ method, params })
  }
}

async function harness(turnTimeoutMs = 0) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.sessionProjections.register(codexThreadBindingProjectionDefinition)
  const appServer = new FakeAppServer()
  const never = new Promise<never>(() => {})
  const supervisor = {
    connect: async () => ({ generation: 1, client: appServer, failure: never }),
  } as unknown as CodexAppServerSupervisor
  const factory: AgentDriverFactory = {
    driverId: 'codex',
    createDriver: (runtimeCtx, id, options, session) => {
      const agent = new CodexAgent(runtimeCtx, id, options, session, supervisor, {
        cwd: '/workspace', approvalPolicy: 'never', sandbox: 'workspace-write',
      }, turnTimeoutMs)
      return {
        driverId: 'codex',
        agent,
        start: (source, signal) => agent.start(source, signal),
        dispose: () => agent.dispose(),
      }
    },
  }
  ctx.agents.setTransferPorts('codex', {
    source: { driverId: 'codex', exportArchivedContext: vi.fn(), exportPortableContext: vi.fn() },
    target: { driverId: 'codex', importCapabilities: vi.fn(), describeAuthentication: vi.fn(), importPortableContext: vi.fn(), createImportedAgent: vi.fn() },
  })
  ctx.agents.setDriverFactory('codex', factory)
  return { ctx, appServer, supervisor }
}

describe('CodexAgent lifecycle integration', () => {
  it('publishes an imported Session only after a fresh checkpoint thread starts', async () => {
    const { ctx, appServer } = await harness()
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2
    const sourceId = SessionId('codex-import-source')
    const targetId = SessionId('codex-import-target')
    const model = { provider: 'codex:llm_proxy', id: 'llm_proxy/glm-5' }
    const context: PortableAgentContextV1 = { version: 1,
      source: { version: 1, sessionId: sourceId,
        driver: { id: 'codex', version: 'protocol:1;fork:fork-abc' }, model },
      items: [], effectiveItemIds: [], compactions: [] }
    const source: AgentTransferSourcePort = { driverId: 'codex',
      exportArchivedContext: vi.fn(), exportPortableContext: async () => ({ context, privateSnapshot: codexPrivateSnapshot(fixture) }) }
    const importSupervisor = {
      connect: async () => ({ generation: 1, client: appServer, failure: new Promise<never>(() => {}) }),
    } as unknown as CodexAppServerSupervisor
    ctx.agents.setDriverFactory('codex:llm_proxy', {
      driverId: 'codex',
      createDriver: (runtimeCtx, id, options, session) => {
        const agent = new CodexAgent(runtimeCtx, id, options, session, importSupervisor,
          { cwd: '/workspace', model: model.id, approvalPolicy: 'never', sandbox: 'danger-full-access' })
        return { driverId: 'codex', agent, start: (source, signal) => agent.start(source, signal),
          dispose: () => agent.dispose() }
      },
    })
    const target = codexTransferTarget(() => [model], () => fixture.runtimeRevision)
    const prepared = await prepareAgentTransfer(source, target, sourceId, targetId, model)
    const committed = await prepared.commit(false)
    appServer.startThreadFromCheckpoint.mockResolvedValueOnce('imported-thread' as never)
    const handle = await createCodexImportedAgent(ctx, committed, { cwd: '/workspace' })
    expect(appServer.startThread).not.toHaveBeenCalled()
    expect(appServer.startThreadFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace', model: model.id }), fixture, expect.any(AbortSignal))
    expect(ctx.sessions.get(targetId)?.header.importLineage).toEqual({
      sourceSessionId: sourceId, sourceDriverId: 'codex', importId: prepared.lineage.importId,
    })
    expect(ctx.sessions.get(targetId)?.snapshotEvents().some(event => event.type === 'codex/thread-bound'
      && event.data.threadId === 'imported-thread')).toBe(true)
    await handle.dispose()

    const failedId = SessionId('codex-import-failed')
    const failure = await prepareAgentTransfer(source, target, sourceId, failedId, model)
    appServer.startThreadFromCheckpoint.mockRejectedValueOnce(new Error('fork rejected checkpoint'))
    await expect(createCodexImportedAgent(ctx, await failure.commit(false)))
      .rejects.toThrow('fork rejected checkpoint')
    expect(ctx.sessions.get(failedId)).toBeUndefined()
    expect(ctx.agents.get(failedId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('routes fork audit requests to the owning Session and refuses a failed durable flush', async () => {
    const { ctx } = await harness()
    const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const handle = await ctx.agents.create({
      sessionId: SessionId('fork-audit-session'),
      agentOptions: { provider: 'codex', model: 'gpt-codex' },
    })
    const agent = handle.agent as CodexAgent
    await expect(agent.handleInteraction('dshAudit/cursor', { threadId: 'codex-thread-1' }))
      .resolves.toEqual({ version: 1, sequence: 0, eventId: null })
    await expect(agent.handleInteraction('dshAudit/append', { threadId: 'codex-thread-1', event: {
      version: 1, sequence: 1, eventId: 'event-1', time: 1, threadId: 'codex-thread-1', turn: 0,
      kind: 'context/config', config: { kind: 'inline', value: { model: 'gpt-codex' } },
    } })).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(1)
    expect(flush).toHaveBeenCalledOnce()
    await expect(agent.handleInteraction('dshAudit/cursor', { threadId: 'other-thread' }))
      .rejects.toThrow('another thread')
    await expect(agent.handleInteraction('dshAudit/artifact', { threadId: 'other-thread' }))
      .rejects.toThrow('another thread')
    await expect(agent.handleInteraction('dshAudit/artifact', { threadId: 'codex-thread-1' }))
      .rejects.toThrow('audit artifact storage is unavailable')
    flush.mockResolvedValue(false)
    await expect(agent.handleInteraction('dshAudit/append', { threadId: 'codex-thread-1', event: {
      version: 1, sequence: 2, eventId: 'event-2', time: 2, threadId: 'codex-thread-1', turn: 0,
      kind: 'context/config', config: { kind: 'inline', value: { model: 'gpt-codex' } },
    } })).rejects.toThrow('durable Session audit storage is unavailable')
    await expect(agent.handleInteraction('dshAudit/cursor', { threadId: 'codex-thread-1' }))
      .rejects.toThrow('durable Session audit storage is unavailable')
    await handle.dispose()
  })

  it('binds model attempts only to the live Codex thread and turn', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('gateway-bound-session'),
      agentOptions: { provider: 'codex', model: 'gpt-codex' },
    })
    const agent = handle.agent as CodexAgent
    const metadata = {
      sessionId: 'codex-session-1', threadId: 'codex-thread-1', turnId: 'codex-turn-1',
      purpose: 'inference' as const, attemptId: '761024d8-3ad1-4b7e-9cd3-f3e682e3cc54',
    }
    expect(agent.bindModelAttempt(metadata)).toBeUndefined()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(agent.bindModelAttempt(metadata)).toEqual({ dshSessionId: agent.id, dshTurn: 1 }) })
    expect(agent.bindModelAttempt({ ...metadata, threadId: 'other-thread' })).toBeUndefined()
    expect(agent.bindModelAttempt({ ...metadata, turnId: 'other-turn' })).toBeUndefined()
    agent.session.append('codex/model-audit', {
      version: 1, turn: 1, attemptId: metadata.attemptId, purpose: 'inference',
      phase: 'original-request', payload: { rawBody: '{}' },
    })
    expect(agent.bindModelAttempt(metadata)).toBeUndefined()
    expect(agent.bindModelAttempt({ ...metadata, attemptId: 'cb212579-7091-4ac0-a45c-12320d4a20c1' }))
      .toEqual({ dshSessionId: agent.id, dshTurn: 1 })
    appServer.complete('codex-turn-1')
    await agent.whenIdle()
    expect(agent.bindModelAttempt(metadata)).toBeUndefined()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('runs Codex and standard Sessions through exactly their own loops', async () => {
    const { ctx, appServer } = await harness()
    const standardAdapter = new MockAdapter([textResponse('Standard answer')])
    ctx.llm.registerAdapter(['standard-provider'], standardAdapter)
    const codex = await ctx.agents.create({
      sessionId: SessionId('codex-only-loop'),
      agentOptions: { provider: 'codex', model: 'gpt-codex' },
    })
    const standard = await ctx.agents.create({
      sessionId: SessionId('standard-only-loop'),
      agentOptions: { provider: 'standard-provider', model: 'shared-model' },
    })
    codex.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Codex turn' }], source: { kind: 'user' } }))
    standard.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Standard turn' }], source: { kind: 'user' } }))
    await Promise.all([codex.agent.whenIdle(), standard.agent.whenIdle()])

    expect(appServer.startTurn).toHaveBeenCalledOnce()
    expect(standardAdapter.requests).toHaveLength(1)
    const codexEvents = codex.agent.session.snapshotEvents()
    const standardEvents = standard.agent.session.snapshotEvents()
    expect(codexEvents.find(event => event.type === 'agent/driver-selected')?.data)
      .toEqual({ version: 1, driverId: 'codex' })
    expect(standardEvents.find(event => event.type === 'agent/driver-selected')?.data)
      .toEqual({ version: 1, driverId: 'standard' })
    expect(codexEvents.some(event => event.type === 'request/header')).toBe(false)
    expect(standardEvents.some(event => event.type === 'codex/thread-bound' || event.type === 'codex/turn-bound')).toBe(false)
    expect(codexEvents.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(standardEvents.filter(event => event.type === 'assistant/message')).toHaveLength(1)

    await Promise.all([codex.dispose(), standard.dispose()])
    await ctx.fiber.dispose()
  })

  it('uses the shared factory lifecycle while Codex owns the complete turn', async () => {
    const { ctx, appServer } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-session'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex', model: 'gpt-codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Do the work' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect(appServer.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace' }),
      expect.any(AbortSignal),
    )
    expect(appServer.startTurn).toHaveBeenCalledOnce()
    expect(handle.agent.session.snapshotEvents().map(event => event.type)).toEqual([
      'agent/driver-selected',
      'codex/thread-bound',
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'user/message',
      'codex/tool-catalog',
      'codex/turn-bound',
      'codex/item/started',
      'codex/item/completed',
      'codex/usage',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const assistant = handle.agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' ? assistant.data.message.content : undefined)
      .toEqual([{ type: 'text', text: 'Codex answer' }])
    expect(assistant?.type === 'assistant/message' ? assistant.data.usage : undefined).toMatchObject({
      inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 5, reasoningTokens: 1,
    })

    await handle.dispose()
  })

  it('changes the model on the next turn of the same Codex thread', async () => {
    const { ctx, appServer } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-model-switch'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex', model: 'provider/model-a' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'First' }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    handle.agent.selectModelForNextTurn?.('provider/model-b')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Second' }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(appServer.startThread).toHaveBeenCalledOnce()
    expect(appServer.startTurn.mock.calls.map(call => [call[0], call[4]])).toEqual([
      ['codex-thread-1', 'provider/model-a'],
      ['codex-thread-1', 'provider/model-b'],
    ])
    await handle.dispose()
  })

  it('refreshes the DSH tool catalog on each turn and records the exact catalog hash', async () => {
    const { ctx, appServer } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-tool-catalog'), agentOptions: { provider: 'codex', model: 'local/model' },
    })
    const agent = handle.agent as CodexAgent
    const addTool = (name: string): void => {
      agent.ctx.tools.register({
        name, description: `Tool ${name}`, parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
        execute: async () => 'done',
      })
    }
    addTool('first_tool')
    expect(ctx.tools.schemas().some(tool => tool.name === 'first_tool')).toBe(false)
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    addTool('second_tool')
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const catalogs = handle.agent.session.snapshotEvents().filter(event => event.type === 'codex/tool-catalog')
    expect(catalogs).toHaveLength(2)
    expect(catalogs[0]?.data.hash).not.toBe(catalogs[1]?.data.hash)
    const calls = appServer.startTurn.mock.calls
    expect(calls[0]?.[5]).toEqual(catalogs[0]?.data.tools)
    expect(calls[1]?.[5]).toEqual(catalogs[1]?.data.tools)
    expect(calls[0]?.[5]?.map(tool => tool.name)).toContain('first_tool')
    expect(calls[1]?.[5]?.map(tool => tool.name)).toContain('second_tool')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('validates item/tool/call and persists the DSH call and result around execution', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-tool-call-bound'), agentOptions: { provider: 'codex', model: 'local/model' },
    })
    const agent = handle.agent as CodexAgent
    const execute = vi.fn(async () => 'found')
    agent.ctx.tools.register({
      name: 'lookup', description: 'Lookup',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use lookup' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => {
      const events = agent.session.snapshotEvents()
      if (execute.mock.calls.length === 0) {
        expect(events.some(event => event.type === 'tool/call')).toBe(true)
      } else {
        expect(events.some(event => event.type === 'tool/result')).toBe(true)
      }
      return true
    })
    const call = { threadId: 'codex-thread-1', turnId: 'codex-turn-1', callId: 'native-call-1',
      namespace: null, tool: 'lookup', arguments: { query: 'x' } }
    await expect(agent.handleInteraction('item/tool/call', { ...call, arguments: { query: 3 } }))
      .rejects.toThrow('violate schema')
    await expect(agent.handleInteraction('item/tool/call', { ...call, tool: 'unadvertised' }))
      .rejects.toThrow('not visible')
    await expect(agent.handleInteraction('item/tool/call', call)).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'found' }], success: true,
    })
    expect(flush).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledOnce()
    await expect(agent.handleInteraction('item/tool/call', call)).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'found' }], success: true,
    })
    expect(execute).toHaveBeenCalledOnce()
    await expect(agent.handleInteraction('item/tool/call', { ...call, arguments: { query: 'changed' } }))
      .rejects.toThrow('changed its payload')
    const event = agent.session.snapshotEvents().find(event => event.type === 'codex/tool-call-bound')
    expect(event?.type === 'codex/tool-call-bound' ? event.data : undefined).toMatchObject({
      codexCallId: 'native-call-1', name: 'lookup', arguments: { query: 'x' }, turn: 1,
    })
    expect(event?.type === 'codex/tool-call-bound' ? event.data.dshCallId : '').toMatch(/^codex_[0-9a-f]{64}$/)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'codex/tool-call-bound')).toHaveLength(1)
    const auditedCall = agent.session.snapshotEvents().find(event => event.type === 'tool/call')
    const auditedResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(auditedCall?.type === 'tool/call' ? auditedCall.data.callId : undefined)
      .toBe(event?.type === 'codex/tool-call-bound' ? event.data.dshCallId : undefined)
    expect(auditedResult?.type === 'tool/result' ? auditedResult.data.message.content[0] : undefined)
      .toMatchObject({ isError: false, content: [{ type: 'text', text: 'found' }] })
    appServer.complete('codex-turn-1')
    await agent.whenIdle()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('does not execute a Codex tool if the call audit cannot be persisted', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-tool-call-audit-failure'), agentOptions: { provider: 'codex', model: 'local/model' },
    })
    const agent = handle.agent as CodexAgent
    const execute = vi.fn(async () => 'secret-effect')
    agent.ctx.tools.register({
      name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use lookup' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(agent.handleInteraction('item/tool/call', {
      threadId: 'codex-thread-1', turnId: 'codex-turn-1', callId: 'native-call-1',
      namespace: null, tool: 'lookup', arguments: {},
    })).rejects.toThrow('storage unavailable')
    expect(execute).not.toHaveBeenCalled()
    appServer.complete('codex-turn-1')
    await agent.whenIdle()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('does not return a tool result when its durable audit fails after execution', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-tool-result-audit-failure'), agentOptions: { provider: 'codex', model: 'local/model' },
    })
    const agent = handle.agent as CodexAgent
    const execute = vi.fn(async () => 'irreversible-effect')
    agent.ctx.tools.register({
      name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use lookup' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    const flush = vi.spyOn(ctx.sessions, 'flush')
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('result storage unavailable'))
    await expect(agent.handleInteraction('item/tool/call', {
      threadId: 'codex-thread-1', turnId: 'codex-turn-1', callId: 'native-call-1',
      namespace: null, tool: 'lookup', arguments: {},
    })).rejects.toThrow('result storage unavailable')
    expect(flush).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledOnce()
    await expect(agent.handleInteraction('item/tool/call', {
      threadId: 'codex-thread-1', turnId: 'codex-turn-1', callId: 'native-call-1',
      namespace: null, tool: 'lookup', arguments: {},
    })).rejects.toThrow('result storage unavailable')
    expect(execute).toHaveBeenCalledOnce()
    appServer.complete('codex-turn-1')
    await agent.whenIdle()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('serializes parallel Codex tool outcomes and replays a settled call without a second side effect', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-parallel-tools'), agentOptions: { provider: 'codex', model: 'local/model' },
    })
    const agent = handle.agent as CodexAgent
    const waits = new Map<string, PromiseWithResolvers<string>>()
    const execute = vi.fn(async (args: { query: string }) => {
      const wait = Promise.withResolvers<string>()
      waits.set(args.query, wait)
      return wait.promise
    })
    agent.ctx.tools.register({
      name: 'lookup', description: 'Lookup',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use lookup' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const call = (callId: string, query: string) => ({
      threadId: 'codex-thread-1', turnId: 'codex-turn-1', callId,
      namespace: null, tool: 'lookup', arguments: { query },
    })
    const first = agent.handleInteraction('item/tool/call', call('a', 'first'))
    const duplicate = agent.handleInteraction('item/tool/call', call('a', 'first'))
    const second = agent.handleInteraction('item/tool/call', call('b', 'second'))
    await vi.waitFor(() => { expect(execute).toHaveBeenCalledTimes(2) })
    waits.get('second')?.resolve('result-b')
    await expect(second).resolves.toMatchObject({ contentItems: [{ text: 'result-b' }], success: true })
    waits.get('first')?.resolve('result-a')
    await expect(first).resolves.toMatchObject({ contentItems: [{ text: 'result-a' }], success: true })
    await expect(duplicate).resolves.toMatchObject({ contentItems: [{ text: 'result-a' }], success: true })
    await expect(agent.handleInteraction('item/tool/call', call('a', 'first')))
      .resolves.toMatchObject({ contentItems: [{ text: 'result-a' }], success: true })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(2)
    const unknownId = ToolCallId(`codex_${createHash('sha256')
      .update(JSON.stringify([agent.id, 'codex-turn-1', 'unknown'])).digest('hex')}`)
    agent.session.append('tool/call', { turn: 1, step: 1, callId: unknownId,
      name: 'lookup', arguments: '{"query":"unknown"}' })
    await expect(agent.handleInteraction('item/tool/call', call('unknown', 'unknown')))
      .rejects.toThrow('outcome unknown')
    expect(execute).toHaveBeenCalledTimes(2)
    appServer.complete('codex-turn-1')
    await agent.whenIdle()
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('returns policy refusals as audited errors and image output as verified inline content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-tool-image-'))
    try {
      const { ctx, appServer } = await harness()
      appServer.autoComplete = false
      await ctx.plugin(LocalAttachmentStore, { dshHome: root })
      const image = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        'base64',
      )
      const ref = await ctx.attachments.saveImage({ data: image, mediaType: 'image/png' })
      const handle = await ctx.agents.create({
        sessionId: SessionId('codex-tool-image'), agentOptions: { provider: 'codex', model: 'local/model' },
      })
      const agent = handle.agent as CodexAgent
      const execute = vi.fn(async () => 'image-ready')
      agent.ctx.tools.register({
        name: 'render_image', description: 'Render image', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [
          { type: 'text', text: value as string }, { type: 'image', attachment: ref },
        ] }, execute,
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Render' }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
      vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
      const call = (callId: string) => ({ threadId: 'codex-thread-1', turnId: 'codex-turn-1',
        callId, namespace: null, tool: 'render_image', arguments: {} })
      const response = await agent.handleInteraction('item/tool/call', call('image'))
      expect(response).toEqual({ success: true, contentItems: [
        { type: 'inputText', text: 'image-ready' },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${image.toString('base64')}` },
      ] })
      expect(execute).toHaveBeenCalledOnce()
      agent.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'policy refusal' }))
      const refused = await agent.handleInteraction('item/tool/call', call('refused'))
      expect(refused).toMatchObject({ success: false })
      expect(JSON.stringify(refused)).toContain('policy refusal')
      expect(execute).toHaveBeenCalledOnce()
      const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      expect(results[1]?.data.message.content[0].isError).toBe(true)
      appServer.complete('codex-turn-1')
      await agent.whenIdle()
      await handle.dispose()
      await ctx.fiber.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drains an interrupted tool before closing the DSH turn and records its error', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('codex-tool-cancel'), agentOptions: { provider: 'codex', model: 'local/model' },
    })
    const agent = handle.agent as CodexAgent
    const wait = Promise.withResolvers<string>()
    const execute = vi.fn(async () => wait.promise)
    agent.ctx.tools.register({
      name: 'slow', description: 'Slow', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Slow' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
    const response = agent.handleInteraction('item/tool/call', {
      threadId: 'codex-thread-1', turnId: 'codex-turn-1', callId: 'slow-1',
      namespace: null, tool: 'slow', arguments: {},
    })
    await vi.waitFor(() => { expect(execute).toHaveBeenCalledOnce() })
    agent.cancel({ kind: 'user' })
    wait.resolve('late-success')
    await expect(response).resolves.toMatchObject({ success: false })
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.find(event => event.type === 'tool/result')?.data.message.content[0].isError).toBe(true)
    expect(events.findIndex(event => event.type === 'tool/result'))
      .toBeLessThan(events.findIndex(event => event.type === 'step/end'))
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('resumes exactly the one durable Codex thread and rejects conflicting bindings', async () => {
    const { ctx, appServer, supervisor } = await harness()
    const session = Session.create(SessionId('resume-session'))
    session.append('codex/thread-bound', {
      version: 1,
      threadId: 'codex-thread-1' as never,
      runtimeVersion: '0.149.1',
      cwd: '/persisted-workspace',
    })
    const agent = new CodexAgent(ctx, session.id, { provider: 'codex' }, session, supervisor, {
      cwd: '/ignored-workspace', approvalPolicy: 'never', sandbox: 'workspace-write',
    })
    await agent.start('resume', new AbortController().signal)
    expect(appServer.resumeThread).toHaveBeenCalledWith(
      'codex-thread-1',
      expect.objectContaining({ cwd: '/persisted-workspace' }),
      expect.any(AbortSignal),
    )
    await agent.dispose()

    const conflict = Session.create(SessionId('conflict-session'))
    conflict.append('codex/thread-bound', {
      version: 1, threadId: 'thread-a' as never, runtimeVersion: '0.149.1', cwd: '/workspace',
    })
    conflict.append('codex/thread-bound', {
      version: 1, threadId: 'thread-b' as never, runtimeVersion: '0.149.1', cwd: '/workspace',
    })
    const conflicting = new CodexAgent(ctx, conflict.id, { provider: 'codex' }, conflict, supervisor, {
      cwd: '/workspace', approvalPolicy: 'never', sandbox: 'workspace-write',
    })
    await expect(conflicting.start('resume', new AbortController().signal)).rejects.toThrow(
      'binds Codex threads',
    )
    await conflicting.dispose()
  })

  it('binds a Codex thread when a blank standard session is resumed under Codex', async () => {
    const { ctx, appServer, supervisor } = await harness()
    const session = Session.create(SessionId('blank-standard-session'))
    const agent = new CodexAgent(ctx, session.id, { provider: 'codex', model: 'local/model' }, session, supervisor, {
      cwd: '/workspace', approvalPolicy: 'never', sandbox: 'workspace-write',
    })
    await agent.start('resume', new AbortController().signal)
    expect(appServer.startThread).toHaveBeenCalledOnce()
    expect(session.snapshotEvents().some(event => event.type === 'codex/thread-bound')).toBe(true)
    await agent.dispose()
    const used = Session.create(SessionId('used-standard-session'))
    used.append('turn/start', { turn: 1 })
    const rejected = new CodexAgent(ctx, used.id, { provider: 'codex', model: 'local/model' }, used, supervisor, {
      cwd: '/workspace', approvalPolicy: 'never', sandbox: 'workspace-write',
    })
    await expect(rejected.start('resume', new AbortController().signal)).rejects.toThrow('no Codex thread binding')
    await rejected.dispose()
    await ctx.fiber.dispose()
  })

  it('resumes the durable thread on a new app-server generation after a crash', async () => {
    const { ctx } = await harness()
    const firstClient = new FakeAppServer()
    firstClient.autoComplete = false
    const secondClient = new FakeAppServer()
    const firstFailure = Promise.withResolvers<never>()
    void firstFailure.promise.catch(() => {})
    const never = new Promise<never>(() => {})
    let crashed = false
    const supervisor = {
      connect: vi.fn(async () => crashed
        ? { generation: 2, client: secondClient, failure: never }
        : { generation: 1, client: firstClient, failure: firstFailure.promise }),
    } as unknown as CodexAppServerSupervisor
    const session = Session.create(SessionId('restart-session'))
    const agent = new CodexAgent(ctx, session.id, { provider: 'codex' }, session, supervisor, {
      cwd: '/workspace', approvalPolicy: 'never', sandbox: 'workspace-write',
    })
    await agent.start('startup', new AbortController().signal)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'crash this turn' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(firstClient.startTurn).toHaveBeenCalledOnce() })
    crashed = true
    firstFailure.reject(new Error('app-server crashed'))
    await agent.whenIdle()

    ctx.tools.register({
      name: 'after_resume', description: 'Available after Codex reconnects',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'done',
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue after restart' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(secondClient.resumeThread).toHaveBeenCalledWith(
      'codex-thread-1', expect.objectContaining({ cwd: '/workspace' }), expect.any(AbortSignal),
    )
    expect(secondClient.startTurn).toHaveBeenCalledOnce()
    expect(secondClient.startTurn.mock.calls[0]?.[5]?.map(tool => tool.name)).toContain('after_resume')
    const catalogs = session.snapshotEvents().filter(event => event.type === 'codex/tool-catalog')
    expect(catalogs).toHaveLength(2)
    expect(catalogs[0]?.data.hash).not.toBe(catalogs[1]?.data.hash)
    expect(session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
    await agent.dispose()
  })

  it('serializes queued follow-ups as distinct Codex turns', async () => {
    const { ctx, appServer } = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('queued-session'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    for (const text of ['first', 'second']) {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user' },
      }))
    }
    await handle.agent.whenIdle()
    expect(appServer.startTurn).toHaveBeenCalledTimes(2)
    expect(appServer.startTurn.mock.calls.map(call => call[0])).toEqual([
      'codex-thread-1', 'codex-thread-1',
    ])
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
    await handle.dispose()
  })

  it('runs different persistent Codex threads concurrently with independent status', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const first = await ctx.agents.create({
      sessionId: SessionId('parallel-one'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    const second = await ctx.agents.create({
      sessionId: SessionId('parallel-two'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    for (const [handle, text] of [[first, 'one'], [second, 'two']] as const) {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user' },
      }))
    }
    await vi.waitFor(() => {
      expect(appServer.startTurn).toHaveBeenCalledTimes(2)
      expect(first.agent.status).toBe('running')
      expect(second.agent.status).toBe('running')
    })
    expect(appServer.startTurn.mock.calls.map(call => call[0])).toEqual([
      'codex-thread-1', 'codex-thread-2',
    ])
    appServer.complete('codex-turn-1', 'codex-thread-1')
    appServer.complete('codex-turn-2', 'codex-thread-2')
    await Promise.all([first.agent.whenIdle(), second.agent.whenIdle()])
    expect(first.agent.status).toBe('idle')
    expect(second.agent.status).toBe('idle')
    await Promise.all([first.dispose(), second.dispose()])
  })

  it('uses native turn/steer for input arriving during an active Codex turn', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('steer-session'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'begin' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    handle.agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'change course' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(appServer.steerTurn).toHaveBeenCalledOnce() })
    appServer.complete('codex-turn-1')
    await handle.agent.whenIdle()
    expect(appServer.startTurn).toHaveBeenCalledOnce()
    await handle.dispose()
  })

  it('publishes Codex text and reasoning deltas through the standard assistant stream', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const frames: AssistantStreamFrame[] = []
    ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) })
    const handle = await ctx.agents.create({
      sessionId: SessionId('stream-session'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'stream' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    appServer.delta('item/reasoning/summaryTextDelta', 'codex-turn-1', 'brief thought')
    appServer.delta('item/agentMessage/delta', 'codex-turn-1', 'Codex ')
    appServer.complete('codex-turn-1')
    await handle.agent.whenIdle()

    expect(frames).toHaveLength(11)
    expect(frames[0]?.type).toBe('start')
    expect(frames.at(-1)?.type).toBe('end')
    expect(frames.filter(frame => frame.type === 'chunk').map(frame => frame.chunk.type)).toEqual([
      'block-start', 'reasoning-delta', 'block-end', 'block-start', 'text-delta',
      'text-delta', 'block-end', 'usage', 'finish',
    ])
    const assistant = handle.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' ? assistant.data.message.content : undefined).toEqual([
      { type: 'reasoning', text: 'brief thought' },
      { type: 'text', text: 'Codex answer' },
    ])
    await handle.dispose()
  })

  it('commits multiple agent-message items without rejecting the final one', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('multi-message-session'), meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => { expect(appServer.startTurn).toHaveBeenCalledOnce() })
    appServer.message('codex-turn-1', 'commentary-1', 'Checking', 'Checking now')
    appServer.message('codex-turn-1', 'final-1', 'Done', 'Done.')
    appServer.completeTurn('codex-turn-1')
    await handle.agent.whenIdle()

    const assistant = handle.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' ? assistant.data.message.content : undefined).toEqual([
      { type: 'text', text: 'Checking now' },
      { type: 'text', text: 'Done.' },
    ])
    expect(handle.agent.session.snapshotEvents().some(event => event.type === 'codex/error')).toBe(false)
    await handle.dispose()
  })

  it('passes host-visible image attachments as native localImage input', async () => {
    const { ctx, appServer } = await harness()
    ctx.provide('attachments', {
      imageHostPath: () => '/workspace/.attachments/image.png',
    } as never)
    const handle = await ctx.agents.create({
      sessionId: SessionId('image-session'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: 'sha256:image' as never,
          mediaType: 'image/png', bytes: 4, width: 1, height: 1,
        },
      }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(appServer.startTurn.mock.calls[0]?.[1]).toEqual([
      { type: 'localImage', path: '/workspace/.attachments/image.png' },
    ])
    await handle.dispose()
  })

  it('interrupts and durably closes a timed-out turn', async () => {
    const { ctx, appServer } = await harness(10)
    appServer.autoComplete = false
    const handle = await ctx.agents.create({
      sessionId: SessionId('timeout-session'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'hang' }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    expect(appServer.interruptTurn).toHaveBeenCalledOnce()
    const ended = handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(ended?.type === 'turn/end' ? ended.data.reason : undefined).toEqual({
      kind: 'aborted', reason: { kind: 'hook', reason: 'Codex turn timed out after 10 ms' },
    })
    await handle.dispose()
  })

  it('routes approvals and request-user-input through the scoped DSH interaction services', async () => {
    const { ctx, appServer } = await harness()
    appServer.autoComplete = false
    ctx.on('approval/request', async () => 'allowed-once')
    ctx.on('user-questions/request', async request => ({
      answers: request.questions.map(question => ({ id: question.id, selected: ['Proceed'] })),
    }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('interaction-session'),
      meta: { cwd: '/workspace' },
      agentOptions: { provider: 'codex' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'interact' }], source: { kind: 'user' },
    }))
    await vi.waitFor(() => {
      expect(handle.agent.session.snapshotEvents().some(event => event.type === 'codex/turn-bound')).toBe(true)
    })
    const agent = handle.agent as CodexAgent
    await expect(agent.handleInteraction('item/commandExecution/requestApproval', {
      threadId: 'codex-thread-1', turnId: 'codex-turn-1', itemId: 'command-1',
      availableDecisions: ['accept', 'decline'], reason: 'needs a command',
    })).resolves.toEqual({ decision: 'accept' })
    await expect(agent.handleInteraction('item/tool/requestUserInput', {
      threadId: 'codex-thread-1', turnId: 'codex-turn-1', itemId: 'question-1',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Continue?', isOther: false,
        isSecret: false, options: [{ label: 'Proceed', description: 'Continue work' }],
      }],
    })).resolves.toEqual({ answers: { choice: { answers: ['Proceed'] } } })
    appServer.resolveRequest('question-1')
    expect(handle.agent.session.snapshotEvents().map(event => event.type)).toEqual(
      expect.arrayContaining(['approval/asked', 'approval/decided']),
    )
    const resolved = handle.agent.session.snapshotEvents().find(event => (
      event.type === 'codex/item/updated' && event.data.itemType === 'serverRequest/resolved'
    ))
    expect(resolved?.type === 'codex/item/updated' ? resolved.data.itemId : undefined).toBe('question-1')
    appServer.complete('codex-turn-1')
    await handle.agent.whenIdle()
    await handle.dispose()
  })
})
