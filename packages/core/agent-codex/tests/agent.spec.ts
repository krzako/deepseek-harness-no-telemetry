import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentDriverFactory } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import {
  CodexAgent,
  codexThreadBindingProjectionDefinition,
  type CodexAppServer,
  type CodexNotification,
  type CodexUserInput,
} from '../src/index.ts'
import type { CodexAppServerSupervisor } from '../src/supervisor.ts'

class FakeAppServer implements CodexAppServer {
  private readonly listeners = new Set<(notification: CodexNotification) => void>()
  private threadCounter = 0
  private turnCounter = 0
  autoComplete = true
  initialize = vi.fn(async () => {})
  startThread = vi.fn(async () => `codex-thread-${++this.threadCounter}` as never)
  resumeThread = vi.fn(async () => {})
  startTurn = vi.fn(async (threadId: string, _input: readonly CodexUserInput[]) => {
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
    createDriver: (runtimeCtx, id, options, session) => {
      const agent = new CodexAgent(runtimeCtx, id, options, session, supervisor, {
        cwd: '/workspace', approvalPolicy: 'never', sandbox: 'workspace-write',
      }, turnTimeoutMs)
      return {
        agent,
        start: (source, signal) => agent.start(source, signal),
        dispose: () => agent.dispose(),
      }
    },
  }
  ctx.agents.setDriverFactory('codex', factory)
  return { ctx, appServer, supervisor }
}

describe('CodexAgent lifecycle integration', () => {
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
      'codex/thread-bound',
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'user/message',
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

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue after restart' }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(secondClient.resumeThread).toHaveBeenCalledWith(
      'codex-thread-1', expect.objectContaining({ cwd: '/workspace' }), expect.any(AbortSignal),
    )
    expect(secondClient.startTurn).toHaveBeenCalledOnce()
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
