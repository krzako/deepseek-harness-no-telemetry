import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { CodexAppServerClient } from '../src/index.ts'
import type {
  CodexAppServerTransport,
  CodexContextSnapshotV2,
  CodexInteractionHandler,
  CodexJsonObject,
  CodexNotification,
} from '../src/index.ts'

const checkpoint = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2

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
    expect(transport.calls[1]?.params).toMatchObject({ ephemeral: false, historyMode: 'legacy', cwd: '/workspace' })
    expect(transport.calls[0]?.params).toMatchObject({ capabilities: { experimentalApi: true } })
  })

  it('passes the explicit no-sandbox mode to Codex thread/start', async () => {
    const transport = new FakeTransport()
    transport.responses.set('thread/start', { thread: { id: 'thread-full-access', ephemeral: false } })
    const client = new CodexAppServerClient(transport)
    await client.startThread({ cwd: '/workspace', approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(transport.calls[0]).toMatchObject({
      method: 'thread/start',
      params: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
    })
  })

  it('starts a fresh thread with the intact verified V2 checkpoint', async () => {
    const transport = new FakeTransport()
    transport.responses.set('thread/start', { thread: { id: 'imported-thread', ephemeral: false } })
    const client = new CodexAppServerClient(transport)
    const options = { cwd: '/workspace', sandbox: 'danger-full-access' as const }

    await expect(client.startThreadFromCheckpoint(options, checkpoint)).resolves.toBe('imported-thread')
    expect(transport.calls).toEqual([{ method: 'thread/start', params: {
      cwd: '/workspace', sandbox: 'danger-full-access', ephemeral: false, historyMode: 'legacy',
      dshContextSnapshot: checkpoint,
    } }])
    expect((transport.calls[0]?.params as Record<string, unknown>).dshContextSnapshot).toBe(checkpoint)

    await client.startThread(options)
    expect(transport.calls[1]?.params).not.toHaveProperty('dshContextSnapshot')
  })

  it('rejects a damaged V2 checkpoint locally and propagates a fork refusal', async () => {
    const transport = new FakeTransport()
    const client = new CodexAppServerClient(transport)
    await expect(client.startThreadFromCheckpoint({ cwd: '/workspace' }, {
      ...checkpoint, effectiveHistorySha256: '0'.repeat(64),
    })).rejects.toThrow('invalid V2 checkpoint')
    expect(transport.calls).toEqual([])

    vi.spyOn(transport, 'request').mockRejectedValueOnce(new Error('invalid DSH checkpoint: rollout hash differs'))
    await expect(client.startThreadFromCheckpoint({ cwd: '/workspace' }, checkpoint))
      .rejects.toThrow('invalid DSH checkpoint: rollout hash differs')
  })

  it('sets delegated DSH tool instructions at thread creation but not on resume', async () => {
    const transport = new FakeTransport()
    transport.responses.set('thread/start', { thread: { id: 'thread-dsh', ephemeral: false } })
    transport.responses.set('thread/resume', { thread: { id: 'thread-dsh' } })
    const client = new CodexAppServerClient(transport)
    const options = { cwd: '/workspace', developerInstructions: 'DSH owns tools.' }
    const threadId = await client.startThread(options)
    await client.resumeThread(threadId, options)
    expect(transport.calls).toEqual([
      { method: 'thread/start', params: { cwd: '/workspace', ephemeral: false, historyMode: 'legacy',
        developerInstructions: 'DSH owns tools.' } },
      { method: 'thread/resume', params: { threadId: 'thread-dsh', cwd: '/workspace' } },
    ])
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

  it('sends a per-turn model override without replacing the thread', async () => {
    const transport = new FakeTransport()
    transport.responses.set('turn/start', { turn: { id: 'turn-1' } })
    const client = new CodexAppServerClient(transport)
    const input = [{ type: 'text' as const, text: 'hello', text_elements: [] }]
    await client.startTurn('thread-1' as never, input, undefined, undefined, 'provider/model-a')
    await client.startTurn('thread-1' as never, input, undefined, undefined, 'provider/model-b')
    expect(transport.calls).toEqual([
      { method: 'turn/start', params: { threadId: 'thread-1', input, model: 'provider/model-a' } },
      { method: 'turn/start', params: { threadId: 'thread-1', input, model: 'provider/model-b' } },
    ])
  })

  it('sends a complete dynamic catalog on turn/start', async () => {
    const transport = new FakeTransport()
    transport.responses.set('turn/start', { turn: { id: 'turn-1' } })
    const client = new CodexAppServerClient(transport)
    const dynamicTools = [{ type: 'function' as const, name: 'lookup', description: 'Lookup',
      inputSchema: { type: 'object', properties: {} } }]
    await client.startTurn('thread-1' as never, [{ type: 'text', text: 'go', text_elements: [] }],
      undefined, undefined, undefined, dynamicTools)
    expect(transport.calls[0]).toMatchObject({ method: 'turn/start', params: { dynamicTools } })
  })

  it('sends the owning DSH Session and turn for the fork audit preflight', async () => {
    const transport = new FakeTransport()
    transport.responses.set('turn/start', { turn: { id: 'turn-1' } })
    const client = new CodexAppServerClient(transport)
    await client.startTurn('thread-1' as never, [{ type: 'text', text: 'go', text_elements: [] }],
      undefined, undefined, undefined, [], { sessionId: 'session-1', turn: 3 })
    expect(transport.calls[0]).toMatchObject({
      method: 'turn/start', params: { dshAudit: { sessionId: 'session-1', turn: 3 } },
    })
  })

  it('delegates known interactions and rejects unknown methods without granting them', async () => {
    const transport = new FakeTransport()
    const interactions = vi.fn<CodexInteractionHandler>().mockResolvedValue({ decision: 'decline' })
    new CodexAppServerClient(transport, interactions)

    await expect(transport.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1', turnId: 'turn-1',
    })).resolves.toEqual({ decision: 'decline' })
    const toolCall = { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null,
      tool: 'lookup', arguments: { query: 'x' } }
    await expect(transport.serverRequest('item/tool/call', toolCall)).resolves.toEqual({ decision: 'decline' })
    await expect(transport.serverRequest('dshAudit/cursor', { threadId: 'thread-1' }))
      .resolves.toEqual({ decision: 'decline' })
    await expect(transport.serverRequest('dshAudit/artifact', { threadId: 'thread-1' }))
      .resolves.toEqual({ decision: 'decline' })
    await expect(transport.serverRequest('future/unsafeApproval')).rejects.toThrow(
      'unsupported app-server request',
    )
    expect(interactions).toHaveBeenNthCalledWith(2, 'item/tool/call', toolCall)
    expect(interactions).toHaveBeenNthCalledWith(3, 'dshAudit/cursor', { threadId: 'thread-1' })
    expect(interactions).toHaveBeenNthCalledWith(4, 'dshAudit/artifact', { threadId: 'thread-1' })
    expect(interactions).toHaveBeenCalledTimes(4)
  })
})
