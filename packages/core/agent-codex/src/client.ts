/** Persistent Codex app-server client over the shared DSH JSON-RPC transport. */

import type { Readable, Writable } from 'node:stream'
import { brandString } from '@deepseek-ai/dsh-brand'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { CodexThreadId, CodexTurnId } from './types.ts'
import type {
  CodexAppServer,
  CodexAppServerTransport,
  CodexInteractionHandler,
  CodexInteractionMethod,
  CodexJsonObject,
  CodexNotification,
  CodexThreadOptions,
  CodexTurnRef,
  CodexUserInput,
} from './protocol.ts'

const INTERACTION_METHODS = new Set<string>([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'applyPatchApproval',
  'execCommandApproval',
])

function record(value: unknown, label: string): CodexJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`agent-codex: app-server returned invalid ${label}`)
  }
  return value as CodexJsonObject
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`agent-codex: app-server returned invalid ${label}`)
  }
  return value
}

function threadParams(options: CodexThreadOptions): CodexJsonObject {
  return {
    cwd: options.cwd,
    ...options.model === undefined ? {} : { model: options.model },
    ...options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy },
    ...options.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.approvalsReviewer },
    ...options.sandbox === undefined ? {} : { sandbox: options.sandbox },
  }
}

/**
 * One persistent app-server connection. The caller owns process supervision;
 * this class owns handshake, method validation, and notification fan-out.
 */
export class CodexAppServerClient implements CodexAppServer {
  private readonly listeners = new Set<(notification: CodexNotification) => void>()
  private closed = false

  constructor(
    private readonly transport: CodexAppServerTransport,
    private readonly interactions?: CodexInteractionHandler,
  ) {
    transport.onRequest((method, params) => this.handleRequest(method, params))
    transport.onNotification((method, params) => {
      const notification = { method, params }
      for (const listener of [...this.listeners]) listener(notification)
    })
    transport.start()
  }

  /** Construct a client over newline-delimited JSON-RPC streams. */
  static fromStreams(
    input: Readable,
    output: Writable,
    interactions?: CodexInteractionHandler,
  ): CodexAppServerClient {
    return new CodexAppServerClient(new JsonRpcLineTransport(input, output, {
      rejectMalformedJson: true,
    }), interactions)
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    record(await this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.1.3-alpha.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal), 'initialize response')
    this.transport.notify('initialized')
    await this.transport.flush()
  }

  async startThread(options: CodexThreadOptions, signal?: AbortSignal): Promise<CodexThreadId> {
    const response = record(await this.transport.request('thread/start', {
      ...threadParams(options),
      ephemeral: false,
    }, signal), 'thread/start response')
    const thread = record(response.thread, 'thread/start thread')
    if (thread.ephemeral === true) {
      throw new Error('agent-codex: app-server created an ephemeral thread')
    }
    return brandString<CodexThreadId>(nonEmptyString(thread.id, 'thread/start thread id'))
  }

  async resumeThread(
    threadId: CodexThreadId,
    options: CodexThreadOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = record(await this.transport.request('thread/resume', {
      threadId,
      ...threadParams(options),
    }, signal), 'thread/resume response')
    const thread = record(response.thread, 'thread/resume thread')
    const resumedId = nonEmptyString(thread.id, 'thread/resume thread id')
    if (resumedId !== threadId) {
      throw new Error(`agent-codex: resumed thread ${JSON.stringify(resumedId)} instead of ${JSON.stringify(threadId)}`)
    }
  }

  async startTurn(
    threadId: CodexThreadId,
    input: readonly CodexUserInput[],
    signal?: AbortSignal,
    effort?: string,
  ): Promise<CodexTurnRef> {
    if (input.length === 0) throw new Error('agent-codex: turn input must not be empty')
    const response = record(await this.transport.request('turn/start', {
      threadId,
      input,
      ...effort === undefined ? {} : { effort },
    }, signal), 'turn/start response')
    const turn = record(response.turn, 'turn/start turn')
    return {
      threadId,
      turnId: brandString<CodexTurnId>(nonEmptyString(turn.id, 'turn/start turn id')),
    }
  }

  async steerTurn(
    turn: CodexTurnRef,
    input: readonly CodexUserInput[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (input.length === 0) throw new Error('agent-codex: steering input must not be empty')
    await this.transport.request('turn/steer', {
      threadId: turn.threadId,
      expectedTurnId: turn.turnId,
      input,
    }, signal)
  }

  async interruptTurn(turn: CodexTurnRef, signal?: AbortSignal): Promise<void> {
    await this.transport.request('turn/interrupt', {
      threadId: turn.threadId,
      turnId: turn.turnId,
    }, signal)
  }

  subscribe(listener: (notification: CodexNotification) => void): () => void {
    if (this.closed) throw new Error('agent-codex: app-server client is closed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeTurn(turn: CodexTurnRef, listener: (notification: CodexNotification) => void): () => void {
    return this.subscribe((notification) => {
      const { params } = notification
      if (params.threadId !== turn.threadId) return
      const nestedTurn = params.turn === null || typeof params.turn !== 'object' || Array.isArray(params.turn)
        ? undefined
        : params.turn as CodexJsonObject
      const turnId = params.turnId ?? nestedTurn?.id
      if (turnId !== turn.turnId) return
      listener(notification)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.transport.close()
  }

  private handleRequest(method: string, params: CodexJsonObject): Promise<unknown> {
    if (!INTERACTION_METHODS.has(method)) {
      return Promise.reject(new Error(`agent-codex: unsupported app-server request ${JSON.stringify(method)}`))
    }
    if (this.interactions === undefined) {
      return Promise.reject(new Error(`agent-codex: no interaction handler for ${JSON.stringify(method)}`))
    }
    return this.interactions(method as CodexInteractionMethod, params)
  }
}
