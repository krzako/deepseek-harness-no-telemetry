import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { CodexAppServerClient } from '../src/index.ts'
import type {
  CodexAppServerTransport,
  CodexInteractionHandler,
  CodexJsonObject,
  CodexNotification,
} from '../src/index.ts'

class FakeTransport implements CodexAppServerTransport {
  readonly calls: { method: string; params: object }[] = []
  readonly responses = new Map<string, unknown>()
  started = false
  closed = false
  notifications: { method: string; params?: object }[] = []
  private requestHandler?: (method: string, params: CodexJsonObject) => Promise<unknown>
  private notificationHandler?: (method: string, params: CodexJsonObject) => void

  start(): void { this.started = true }
  close(): void { this.closed = true }
  request(method: string, params: object): Promise<unknown> {
    this.calls.push({ method, params })
    return Promise.resolve(this.responses.get(method) ?? {})
  }
  notify(method: string, params?: object): void {
    this.notifications.push(params === undefined ? { method } : { method, params })
  }
  flush(): Promise<void> { return Promise.resolve() }
  onRequest(handler: (method: string, params: CodexJsonObject) => Promise<unknown>): void {
    this.requestHandler = handler
  }
  onNotification(handler: (method: string, params: CodexJsonObject) => void): void {
    this.notificationHandler = handler
  }
  serverRequest(method: string, params: CodexJsonObject = {}): Promise<unknown> {
    if (this.requestHandler === undefined) throw new Error('missing request handler')
    return this.requestHandler(method, params)
  }
  serverNotification(method: string, params: CodexJsonObject): void {
    this.notificationHandler?.(method, params)
  }
}

describe('CodexAppServerClient', () => {
  it('fails closed on malformed JSON and premature EOF', async () => {
    for (const frame of ['not-json\n', null] as const) {
      const input = new PassThrough()
      const output = new PassThrough()
      const client = CodexAppServerClient.fromStreams(input, output)
      const initialized = client.initialize()
      if (frame === null) input.end()
      else input.write(frame)
      await expect(initialized).rejects.toThrow(
        frame === null ? 'JSON-RPC input closed' : 'malformed JSON',
      )
      client.close()
    }
  })

  it('performs the handshake and persistent start/resume lifecycle', async () => {
    const transport = new FakeTransport()
    transport.responses.set('initialize', { userAgent: 'codex' })
    transport.responses.set('thread/start', { thread: { id: 'thread-1', ephemeral: false } })
    transport.responses.set('thread/resume', { thread: { id: 'thread-1' } })
    const client = new CodexAppServerClient(transport)

    await client.initialize()
    const threadId = await client.startThread({ cwd: '/workspace', approvalPolicy: 'never' })
    await client.resumeThread(threadId, { cwd: '/workspace', approvalPolicy: 'never' })

    expect(transport.started).toBe(true)
    expect(transport.notifications).toEqual([{ method: 'initialized' }])
    expect(transport.calls.map(call => call.method)).toEqual([
      'initialize',
      'thread/start',
      'thread/resume',
    ])
    expect(transport.calls[1]?.params).toMatchObject({ ephemeral: false, cwd: '/workspace' })
  })

  it('routes only notifications belonging to the selected thread and turn', async () => {
    const transport = new FakeTransport()
    transport.responses.set('turn/start', { turn: { id: 'turn-1' } })
    const client = new CodexAppServerClient(transport)
    const turn = await client.startTurn('thread-1' as never, [{
      type: 'text', text: 'hello', text_elements: [],
    }])
    const received: CodexNotification[] = []
    client.subscribeTurn(turn, notification => received.push(notification))

    transport.serverNotification('item/started', {
      threadId: 'thread-2', turnId: 'turn-1', item: {},
    })
    transport.serverNotification('item/started', {
      threadId: 'thread-1', turnId: 'turn-2', item: {},
    })
    transport.serverNotification('item/started', {
      threadId: 'thread-1', turnId: 'turn-1', item: {},
    })
    transport.serverNotification('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
    })

    expect(received.map(event => event.method)).toEqual(['item/started', 'turn/completed'])
  })

  it('delegates known interactions and rejects unknown methods without granting them', async () => {
    const transport = new FakeTransport()
    const interactions = vi.fn<CodexInteractionHandler>().mockResolvedValue({ decision: 'decline' })
    new CodexAppServerClient(transport, interactions)

    await expect(transport.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1',
    })).resolves.toEqual({ decision: 'decline' })
    await expect(transport.serverRequest('future/unsafeApproval')).rejects.toThrow(
      'unsupported app-server request',
    )
    expect(interactions).toHaveBeenCalledOnce()
  })
})
