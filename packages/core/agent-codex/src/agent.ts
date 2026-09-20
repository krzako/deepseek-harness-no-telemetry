/** Codex-owned turn driver projected into the public DSH Agent contract. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import {
  agentEvents,
  Inbox,
  type Agent,
  type AgentCancelCause,
  type AgentEventDispatch,
  type AgentOptions,
  type AgentStatus,
  type AssistantStreamFrame,
  type CancelOptions,
  type InboxTarget,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  LlmAttemptId,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { CodexAppServerConnection, CodexAppServerSupervisor } from './supervisor.ts'
import { CODEX_PROTOCOL_VERSION } from './protocol.ts'
import type { CodexInteractionMethod, CodexJsonObject, CodexNotification, CodexThreadOptions, CodexTurnRef, CodexUserInput } from './protocol.ts'
import type { CodexThreadBinding } from './types.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; wakeRequested: boolean }

interface LiveAssistantStream {
  readonly accumulator: AssistantStreamAccumulator
  readonly attemptId: ReturnType<typeof LlmAttemptId>
  readonly turn: number
  readonly blocks: ContentBlock[]
  index: number
  open: { readonly index: number; readonly type: 'text' | 'reasoning'; text: string } | undefined
}

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function asRecord(value: unknown): CodexJsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as CodexJsonObject
    : undefined
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function codexInput(ctx: Context, messages: readonly UserMessage[]): CodexUserInput[] {
  const input: CodexUserInput[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        input.push({ type: 'text', text: block.text, text_elements: [] })
        continue
      }
      if (block.type === 'image') {
        const path = ctx.get('attachments')?.imageHostPath(block.attachment)
        if (path === undefined) {
          throw new Error('agent-codex: image attachment has no app-server-visible local path')
        }
        input.push({ type: 'localImage', path })
        continue
      }
      throw new Error(`agent-codex: unsupported DSH input block ${JSON.stringify(block.type)}`)
    }
  }
  if (input.length === 0 || input.every(part => part.type === 'text' && part.text.trim().length === 0)) {
    throw new Error('agent-codex: turn input must contain non-empty text or an image')
  }
  return input
}

function eventSnapshot(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new Error('agent-codex: app-server event is not lossless JSON')
  return snapshot as JsonValue
}

/** One DSH agent whose model loop, tools and compaction are owned by Codex. */
export class CodexAgent implements Agent {
  readonly inbox: Inbox
  readonly scope: Scope
  readonly ctx: Context
  private readonly dispatch: AgentEventDispatch
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private connection: CodexAppServerConnection | undefined
  private binding: CodexThreadBinding | undefined
  private unsubscribe: (() => void) | undefined
  private activeTurn: CodexTurnRef | undefined
  private activeReady: PromiseWithResolvers<CodexTurnRef> | undefined
  private terminal: PromiseWithResolvers<CodexJsonObject> | undefined
  private turnFailure: PromiseWithResolvers<never> | undefined
  private early: CodexNotification[] = []
  private steering: Promise<void> = Promise.resolve()
  private terminalObserved = false
  private finalText: string | undefined
  private usage: TokenUsage | undefined
  private assistantAttempt = 0
  private assistantRevision = 0
  private liveStream: LiveAssistantStream | undefined
  private disposed = false
  private unregisterInteraction: (() => void) | undefined

  constructor(
    private readonly runtimeCtx: Context,
    readonly id: SessionId,
    readonly options: AgentOptions,
    readonly session: Session,
    private readonly supervisor: CodexAppServerSupervisor,
    private readonly threadOptions: CodexThreadOptions,
    private readonly turnTimeoutMs = 0,
    private readonly registerInteraction?: (threadId: string, agent: CodexAgent) => () => void,
    private readonly runtimeIdentity = CODEX_PROTOCOL_VERSION,
  ) {
    this.dispatch = agentEvents(runtimeCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const boundary = runtimeCtx.sessionProjections.stateOf(session, 'turnBoundary')
    this.phase = { kind: 'idle', lastTurn: boundary?.lastTurn ?? 0 }
    this.scope = createScope(runtimeCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  async start(source: SessionStartSource, signal: AbortSignal): Promise<void> {
    const connection = await this.supervisor.connect(signal)
    this.connection = connection
    if (source === 'resume') {
      const state = this.runtimeCtx.sessionProjections.stateOf(this.session, 'codexThreadBinding')
      if (state === undefined || state.binding === null) {
        throw new Error(`agent-codex: session ${JSON.stringify(this.id)} has no Codex thread binding`)
      }
      if (state.conflict !== null) throw new Error(`agent-codex: ${state.conflict}`)
      if (state.binding.runtimeVersion !== this.runtimeIdentity) {
        throw new Error(
          `agent-codex: session runtime ${JSON.stringify(state.binding.runtimeVersion)} `
          + `does not match ${JSON.stringify(this.runtimeIdentity)}`,
        )
      }
      this.binding = state.binding
      await Promise.race([
        connection.client.resumeThread(state.binding.threadId, {
          ...this.threadOptions,
          cwd: state.binding.cwd,
        }, signal),
        connection.failure,
      ])
    } else {
      const threadId = await Promise.race([
        connection.client.startThread(this.threadOptions, signal),
        connection.failure,
      ])
      this.binding = {
        version: 1,
        threadId,
        runtimeVersion: this.runtimeIdentity,
        cwd: this.threadOptions.cwd,
      }
      this.session.append('codex/thread-bound', this.binding)
    }
    this.unsubscribe = connection.client.subscribe((notification) => { this.onNotification(notification) })
    this.unregisterInteraction = this.registerInteraction?.(this.binding.threadId, this)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) throw new Error(`agent ${JSON.stringify(this.id)} is disposed`)
    this.inbox.append(target, message)
    if (target === 'next-step' && this.phase.kind === 'running' && !this.terminalObserved) {
      this.enqueueSteering(this.phase)
      return
    }
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void { this.send(message, 'next-turn', true) }
  steer(message: UserMessage): void { this.send(message, 'next-step', true) }
  inject(message: UserMessage): void { this.send(message, 'next-step', false) }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) this.inbox.clear()
    if (this.phase.kind === 'idle') return
    this.phase.abort.abort(cause)
    if (this.phase.kind === 'running' && this.activeTurn !== undefined) {
      void this.connection?.client.interruptTurn(this.activeTurn).catch(() => {})
    }
  }

  async whenIdle(): Promise<void> {
    let observed: Promise<void>
    do await (observed = this.activityDone)
    while (observed !== this.activityDone)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent ${JSON.stringify(this.id)} already has active work`)
    const done = Promise.withResolvers<void>()
    const phase: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(phase)
    this.activityDone = done.promise
    return (async () => {
      try { return await job(phase.abort.signal) }
      finally {
        this.setPhase({ kind: 'idle', lastTurn: phase.lastTurn })
        done.resolve()
        if (phase.wakeRequested && this.inbox.hasPending) this.wake()
      }
    })()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
    this.unsubscribe?.()
    this.unregisterInteraction?.()
    await this.scope.dispose()
  }

  async handleInteraction(method: CodexInteractionMethod, params: CodexJsonObject): Promise<unknown> {
    if (this.binding === undefined || params.threadId !== this.binding.threadId) {
      throw new Error('agent-codex: server request referenced another thread')
    }
    if (params.turnId !== null && params.turnId !== undefined
      && (this.activeTurn === undefined || params.turnId !== this.activeTurn.turnId)) {
      throw new Error('agent-codex: server request referenced another turn')
    }
    const signal = this.phase.kind === 'running' ? this.phase.abort.signal : undefined
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval':
      case 'execCommandApproval': {
        const approval = this.ctx.get('approval')
        if (approval === undefined) return { decision: this.refusalDecision(params) }
        const outcome = await approval.request({
          agent: this,
          toolName: method.includes('file') || method === 'applyPatchApproval'
            ? 'Codex file change'
            : 'Codex command',
          reason: typeof params.reason === 'string' ? params.reason : 'Codex requested approval',
          ...signal === undefined ? {} : { signal },
        })
        if (outcome === 'allowed-once') {
          const available = params.availableDecisions
          if (available === undefined || (Array.isArray(available) && available.includes('accept'))) {
            return { decision: 'accept' }
          }
        }
        return { decision: outcome === 'cancelled' ? 'cancel' : this.refusalDecision(params) }
      }
      case 'item/permissions/requestApproval': {
        const approval = this.ctx.get('approval')
        if (approval === undefined) return { permissions: {}, scope: 'turn' }
        const outcome = await approval.request({
          agent: this,
          toolName: 'Codex permission grant',
          reason: typeof params.reason === 'string' ? params.reason : 'Codex requested additional permissions',
          ...signal === undefined ? {} : { signal },
        })
        return outcome === 'allowed-once'
          ? { permissions: eventSnapshot(params.permissions ?? {}), scope: 'turn' }
          : { permissions: {}, scope: 'turn' }
      }
      case 'item/tool/requestUserInput': {
        const userQuestions = this.ctx.get('userQuestions')
        if (userQuestions === undefined) return { answers: {} }
        if (!Array.isArray(params.questions)) throw new Error('agent-codex: invalid user-input questions')
        const questions = params.questions.map((candidate, index) => {
          const question = asRecord(candidate)
          if (question === undefined || typeof question.id !== 'string' || typeof question.question !== 'string') {
            throw new Error(`agent-codex: invalid user-input question ${index}`)
          }
          if (question.isSecret === true) {
            throw new Error('agent-codex: secret user-input questions are not supported')
          }
          const options = Array.isArray(question.options)
            ? question.options.map((candidateOption) => {
              const option = asRecord(candidateOption)
              if (option === undefined || typeof option.label !== 'string') {
                throw new Error('agent-codex: invalid user-input option')
              }
              return {
                label: option.label,
                ...typeof option.description === 'string' ? { description: option.description } : {},
              }
            })
            : undefined
          return {
            id: question.id,
            question: question.question,
            ...typeof question.header === 'string' ? { header: question.header } : {},
            ...options === undefined ? {} : { options },
          }
        })
        const answer = await userQuestions.ask({
          agent: this,
          questions,
          ...signal === undefined ? {} : { signal },
        })
        return {
          answers: Object.fromEntries(answer.answers.map(item => [
            item.id,
            { answers: [...item.selected, ...item.custom === undefined ? [] : [item.custom]] },
          ])),
        }
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      case 'item/tool/call':
        throw new Error('agent-codex: dynamic tool calls are not enabled')
      case 'account/chatgptAuthTokens/refresh':
        throw new Error('agent-codex: host token refresh is not enabled')
      case 'attestation/generate':
        throw new Error('agent-codex: host attestation is not enabled')
    }
  }

  private refusalDecision(params: CodexJsonObject): 'cancel' | 'decline' {
    const available = params.availableDecisions
    if (!Array.isArray(available)) return 'decline'
    if (available.includes('cancel')) return 'cancel'
    if (available.includes('decline')) return 'decline'
    throw new Error('agent-codex: approval request offered no safe refusal')
  }

  private setPhase(next: Phase): void {
    const before = this.status
    this.phase = next
    if (before !== this.status) this.dispatch.emit('agent/status', { status: this.status })
  }

  private wake(): void {
    if (this.phase.kind !== 'idle') {
      this.phase.wakeRequested = true
      return
    }
    const done = Promise.withResolvers<void>()
    this.activityDone = done.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      wakeRequested: false,
    })
    void this.runtimeCtx.agents.withInitiator(this, () => this.drive()).then(done.resolve, done.reject)
  }

  private async drive(): Promise<void> {
    try {
      while (this.inbox.hasPending && !this.disposed) await this.runTurn()
    } catch (cause: unknown) {
      this.dispatch.emit('agent/error', {
        turn: this.phase.kind === 'running' ? this.phase.turn : 0,
        step: 1,
        error: cause,
      })
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending && !this.disposed) this.wake()
      }
    }
  }

  private async runTurn(): Promise<void> {
    if (this.phase.kind !== 'running' || this.connection === undefined || this.binding === undefined) {
      throw new Error('agent-codex: turn started outside a live driver')
    }
    const phase = this.phase
    await this.ensureConnection(phase.abort.signal)
    const turn = phase.turn + 1
    phase.turn = turn
    this.session.append('turn/start', { turn })
    const messages = this.inbox.claim('next-turn', turn)
    if (messages.length === 0) {
      this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return
    }
    this.session.append('step/start', { turn, step: 1 })
    for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
    this.finalText = undefined
    this.usage = undefined
    this.early = []
    this.terminalObserved = false
    this.terminal = Promise.withResolvers<CodexJsonObject>()
    this.turnFailure = Promise.withResolvers<never>()
    void this.turnFailure.promise.catch(() => {})
    this.activeReady = Promise.withResolvers<CodexTurnRef>()
    void this.activeReady.promise.catch(() => {})
    const timeout = this.turnTimeoutMs > 0
      ? setTimeout(() => {
        phase.abort.abort({ kind: 'hook', reason: `Codex turn timed out after ${this.turnTimeoutMs} ms` })
      }, this.turnTimeoutMs)
      : undefined
    try {
      const active = await Promise.race([
        this.connection.client.startTurn(
          this.binding.threadId,
          codexInput(this.runtimeCtx, messages),
          phase.abort.signal,
          this.options.reasoningEffort,
        ),
        this.connection.failure,
      ])
      this.activeTurn = active
      this.activeReady.resolve(active)
      this.beginAssistantStream(turn)
      this.session.append('codex/turn-bound', {
        version: 1,
        turn,
        codexTurnId: active.turnId,
      })
      const early = this.early.splice(0)
      for (const notification of early) this.onNotification(notification)
      const onAbort = (): void => { void this.connection?.client.interruptTurn(active).catch(() => {}) }
      const locallyAborted = Promise.withResolvers<never>()
      void locallyAborted.promise.catch(() => {})
      const rejectAbort = (): void => {
        onAbort()
        locallyAborted.reject(new Error('agent-codex: turn interrupted locally'))
      }
      phase.abort.signal.addEventListener('abort', rejectAbort, { once: true })
      if (phase.abort.signal.aborted) rejectAbort()
      let terminal: CodexJsonObject
      try {
        terminal = await Promise.race([
          this.terminal.promise,
          this.connection.failure,
          this.turnFailure.promise,
          locallyAborted.promise,
        ])
        await this.steering
      } finally {
        phase.abort.signal.removeEventListener('abort', rejectAbort)
      }
      const status = terminal.status
      if (status === 'completed') {
        this.commitAssistant(turn)
        this.session.append('step/end', { turn, step: 1 })
        this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      } else if (phase.abort.signal.aborted || status === 'interrupted') {
        this.commitAssistant(turn, true)
        this.session.append('step/end', { turn, step: 1 })
        const reason = phase.abort.signal.reason as AgentCancelCause | undefined
        this.session.append('turn/end', {
          turn,
          reason: { kind: 'aborted', reason: reason ?? { kind: 'user' } },
        })
      } else {
        throw new Error(`agent-codex: Codex turn ended with status ${String(status)}`)
      }
    } catch (cause: unknown) {
      this.abandonAssistantStream()
      this.activeReady.reject(error(cause))
      const normalized = error(cause)
      this.session.append('codex/error', {
        version: 1,
        turn,
        stage: 'turn',
        message: normalized.message,
      })
      this.session.append('step/end', { turn, step: 1 })
      if (phase.abort.signal.aborted) {
        this.session.append('turn/end', {
          turn,
          reason: { kind: 'aborted', reason: phase.abort.signal.reason as AgentCancelCause },
        })
      } else {
        this.session.append('turn/end', {
          turn,
          reason: { kind: 'error', error: { message: normalized.message, code: 'CODEX' } },
        })
      }
      throw normalized
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      this.activeTurn = undefined
      this.activeReady = undefined
      this.terminal = undefined
      this.turnFailure = undefined
      this.early = []
      this.terminalObserved = false
      this.liveStream = undefined
    }
  }

  private async ensureConnection(signal: AbortSignal): Promise<void> {
    const previous = this.connection
    const connection = await this.supervisor.connect(signal)
    if (connection.generation === previous?.generation) return
    if (this.binding === undefined) throw new Error('agent-codex: cannot reconnect without a thread binding')
    await Promise.race([
      connection.client.resumeThread(this.binding.threadId, {
        ...this.threadOptions,
        cwd: this.binding.cwd,
      }, signal),
      connection.failure,
    ])
    this.unsubscribe?.()
    this.connection = connection
    this.unsubscribe = connection.client.subscribe((notification) => { this.onNotification(notification) })
  }

  private enqueueSteering(phase: Extract<Phase, { kind: 'running' }>): void {
    const ready = this.activeReady
    if (ready === undefined) return
    this.steering = this.steering.then(async () => {
      const active = this.activeTurn ?? await ready.promise
      if (this.phase !== phase || this.terminalObserved || phase.abort.signal.aborted) return
      const messages = this.inbox.claim('next-step', phase.turn)
      if (messages.length === 0) return
      for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
      await Promise.race([
        this.connection?.client.steerTurn(active, codexInput(this.runtimeCtx, messages), phase.abort.signal)
          ?? Promise.reject(new Error('agent-codex: missing app-server connection')),
        this.connection?.failure ?? Promise.reject(new Error('agent-codex: missing app-server generation')),
      ])
    }).catch((cause: unknown) => {
      this.turnFailure?.reject(error(cause))
    })
  }

  private onNotification(notification: CodexNotification): void {
    if (this.binding === undefined || notification.params.threadId !== this.binding.threadId) return
    const active = this.activeTurn
    const nestedTurn = asRecord(notification.params.turn)
    const notificationTurnId = notification.params.turnId ?? nestedTurn?.id
    if (active === undefined) {
      if (this.terminal !== undefined) this.early.push(notification)
      return
    }
    if (notification.method === 'serverRequest/resolved') {
      const requestId = typeof notification.params.requestId === 'string'
        ? notification.params.requestId
        : 'unknown'
      const turn = this.phase.kind === 'running' ? this.phase.turn : 0
      this.session.append('codex/item/updated', {
        version: 1,
        turn,
        codexTurnId: active.turnId,
        itemId: requestId,
        itemType: notification.method,
        item: eventSnapshot(notification.params),
      })
      return
    }
    if (notificationTurnId !== active.turnId) return
    const turn = this.phase.kind === 'running' ? this.phase.turn : 0
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const item = asRecord(notification.params.item)
      if (item === undefined) return
      const itemId = typeof item.id === 'string' ? item.id : 'unknown'
      const itemType = typeof item.type === 'string' ? item.type : 'unknown'
      this.session.append(`codex/item/${notification.method === 'item/started' ? 'started' : 'completed'}`, {
        version: 1,
        turn,
        codexTurnId: active.turnId,
        itemId,
        itemType,
        item: eventSnapshot(item),
      })
      if (notification.method === 'item/completed' && itemType === 'agentMessage'
        && typeof item.text === 'string' && (item.phase === 'final_answer' || item.phase === null)) {
        this.finalText = item.text
      }
      return
    }
    if (notification.method.endsWith('/delta')
      || notification.method.endsWith('/outputDelta')
      || notification.method.endsWith('/summaryTextDelta')
      || notification.method.endsWith('/textDelta')) {
      if (notification.method === 'item/agentMessage/delta' && typeof notification.params.delta === 'string') {
        this.pushAssistantDelta('text', notification.params.delta)
      } else if ((notification.method === 'item/reasoning/summaryTextDelta'
        || notification.method === 'item/reasoning/textDelta')
        && typeof notification.params.delta === 'string') {
        this.pushAssistantDelta('reasoning', notification.params.delta)
      }
      const itemId = typeof notification.params.itemId === 'string' ? notification.params.itemId : 'unknown'
      this.session.append('codex/item/updated', {
        version: 1,
        turn,
        codexTurnId: active.turnId,
        itemId,
        itemType: notification.method,
        item: eventSnapshot(notification.params),
      })
      return
    }
    if (notification.method === 'thread/tokenUsage/updated') {
      const tokenUsage = asRecord(notification.params.tokenUsage)
      const last = asRecord(tokenUsage?.last)
      if (last === undefined) return
      const usage = {
        inputTokens: integer(last.inputTokens),
        outputTokens: integer(last.outputTokens),
        cacheReadTokens: integer(last.cachedInputTokens),
        cacheWriteTokens: integer(last.cacheWriteInputTokens),
        reasoningTokens: integer(last.reasoningOutputTokens),
      }
      this.usage = usage
      this.session.append('codex/usage', {
        version: 1,
        turn,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cacheReadTokens,
        cacheWriteInputTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningTokens,
      })
      return
    }
    if (notification.method === 'turn/completed' && nestedTurn !== undefined) {
      this.terminalObserved = true
      this.terminal?.resolve(nestedTurn)
    }
  }

  private commitAssistant(turn: number, interrupted = false): void {
    const live = this.liveStream
    if (live === undefined) return
    const finalText = this.finalText
    if (finalText !== undefined && finalText.length > 0) {
      if (live.open?.type !== 'text') this.openAssistantBlock('text')
      const streamed = live.open?.text ?? ''
      if (!finalText.startsWith(streamed)) {
        throw new Error('agent-codex: final agent message does not match its streamed prefix')
      }
      this.pushAssistantDelta('text', finalText.slice(streamed.length))
    }
    this.closeAssistantBlock()
    if (live.blocks.length === 0) {
      this.abandonAssistantStream()
      return
    }
    if (this.usage !== undefined) this.pushAssistantChunk({ type: 'usage', usage: this.usage })
    this.pushAssistantChunk({
      type: 'finish',
      reason: interrupted
        ? { kind: 'aborted', failure: { message: 'Codex turn interrupted', code: 'ABORTED' } }
        : { kind: 'stop' },
    })
    const event = this.session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: live.blocks,
        source: { provider: 'codex', model: this.options.model ?? 'codex' },
      }),
      stream: [...live.accumulator.snapshot()],
      ...this.usage === undefined ? {} : { usage: this.usage },
      ...interrupted ? { interrupted: true as const } : {},
    }, { surfaceOp: 'append' })
    this.dispatch.emit('agent/assistant-stream', { frame: {
      type: 'end',
      attemptId: live.attemptId,
      revision: ++this.assistantRevision,
      index: live.index,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq },
    } })
    this.liveStream = undefined
  }

  private beginAssistantStream(turn: number): void {
    const attemptId = LlmAttemptId(`${this.id}:codex:${++this.assistantAttempt}`)
    this.liveStream = {
      accumulator: new AssistantStreamAccumulator(), attemptId, turn, blocks: [], index: 0, open: undefined,
    }
    this.dispatch.emit('agent/assistant-stream', { frame: {
      type: 'start', attemptId, revision: ++this.assistantRevision, turn, step: 1,
    } })
  }

  private openAssistantBlock(type: 'text' | 'reasoning'): void {
    const live = this.liveStream
    if (live === undefined || live.open?.type === type) return
    this.closeAssistantBlock()
    const index = live.blocks.length
    live.open = { index, type, text: '' }
    this.pushAssistantChunk({ type: 'block-start', index, blockType: type })
  }

  private pushAssistantDelta(type: 'text' | 'reasoning', text: string): void {
    if (text.length === 0) return
    this.openAssistantBlock(type)
    const open = this.liveStream?.open
    if (open === undefined) return
    open.text += text
    this.pushAssistantChunk(type === 'text'
      ? { type: 'text-delta', index: open.index, text }
      : { type: 'reasoning-delta', index: open.index, text })
  }

  private closeAssistantBlock(): void {
    const live = this.liveStream
    const open = live?.open
    if (live === undefined || open === undefined) return
    const block: ContentBlock = { type: open.type, text: open.text }
    live.blocks.push(block)
    live.open = undefined
    this.pushAssistantChunk({ type: 'block-end', index: open.index, block })
  }

  private pushAssistantChunk(chunk: StreamChunk): void {
    const live = this.liveStream
    if (live === undefined) return
    const timed = live.accumulator.push({ time: Date.now(), chunk })
    const frame: AssistantStreamFrame = {
      type: 'chunk',
      attemptId: live.attemptId,
      revision: ++this.assistantRevision,
      index: live.index++,
      time: timed.time,
      chunk: timed.chunk,
    }
    this.dispatch.emit('agent/assistant-stream', { frame })
  }

  private abandonAssistantStream(): void {
    const live = this.liveStream
    if (live === undefined) return
    this.dispatch.emit('agent/assistant-stream', { frame: {
      type: 'end',
      attemptId: live.attemptId,
      revision: ++this.assistantRevision,
      index: live.index,
      outcome: { kind: 'abandoned' },
    } })
    this.liveStream = undefined
  }
}
