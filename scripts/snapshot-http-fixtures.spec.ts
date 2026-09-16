import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

const httpMock = vi.hoisted(() => ({ createServer: vi.fn() }))

vi.mock('node:http', () => ({ createServer: httpMock.createServer }))

// Snapshot plugins are plain runtime JavaScript loaded by cordis.yml.
// @ts-expect-error The fixture intentionally has no declaration artifact.
import * as loopbackFixtureModule from '../snapshots/session/loopback-fixture-server.mjs'

interface LoopbackFixtureOptions {
  readonly label: string
  readonly onCleanup: () => void
  readonly onListening: (address: { port: number }) => void
  readonly requestListener: () => void
}

const typedLoopbackFixtureModule = loopbackFixtureModule as unknown as {
  readonly applyLoopbackServerEffect: (ctx: Context, options: LoopbackFixtureOptions) => Promise<void>
}
const { applyLoopbackServerEffect } = typedLoopbackFixtureModule
const nativeFetch = globalThis.fetch

class FixtureServer extends EventEmitter {
  readonly started = Promise.withResolvers<undefined>()
  listening = false
  closed = false
  connectionsClosed = false
  unreferenced = false
  private listenCallback: (() => void) | undefined
  private port = 0

  listen(_port: number, _host: string, callback: () => void): this {
    this.listenCallback = callback
    this.started.resolve(undefined)
    return this
  }

  finishListening(port = 54321): void {
    this.port = port
    this.listening = true
    this.listenCallback?.()
  }

  address(): { address: string; family: string; port: number } | null {
    return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: this.port } : null
  }

  unref(): this {
    this.unreferenced = true
    return this
  }

  close(callback: (error?: Error) => void): this {
    this.listening = false
    this.closed = true
    callback()
    return this
  }

  closeAllConnections(): void {
    this.connectionsClosed = true
  }
}

function nextServer(): FixtureServer {
  const server = new FixtureServer()
  httpMock.createServer.mockReturnValueOnce(server)
  return server
}

function captureErrors(ctx: Context): unknown[] {
  const errors: unknown[] = []
  ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
  return errors
}

async function disposeWhileStarting(fiber: { dispose(): Promise<unknown> }, server: FixtureServer): Promise<void> {
  await server.started.promise
  const disposal = fiber.dispose()
  const settled = vi.fn()
  void disposal.then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  server.finishListening()
  await disposal
}

afterEach(() => {
  globalThis.fetch = nativeFetch
  httpMock.createServer.mockReset()
})

describe('snapshot HTTP fixture lifecycle', () => {
  it('runs owner cleanup and closes the listener when disposal wins the startup race', async () => {
    const server = nextServer()
    const ctx = new Context()
    const errors = captureErrors(ctx)
    const onCleanup = vi.fn()
    const onListening = vi.fn()
    const fiber = ctx.plugin({
      name: 'loopback-fixture-lifecycle-test',
      apply: testCtx => applyLoopbackServerEffect(testCtx, {
        label: 'loopback-fixture-lifecycle-test',
        onCleanup,
        onListening,
        requestListener: () => {},
      }),
    })
    await disposeWhileStarting(fiber, server)

    expect(server).toMatchObject({ closed: true, connectionsClosed: true, unreferenced: true })
    expect(onListening).toHaveBeenCalledWith(expect.objectContaining({ port: 54321 }))
    expect(onCleanup).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
  })

})
