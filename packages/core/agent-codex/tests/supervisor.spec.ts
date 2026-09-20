import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CodexAppServerSupervisor } from '../src/index.ts'

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly exit: (outcome?: SubprocessOutcome) => void
  readonly terminate: ReturnType<typeof vi.fn<SubprocessHandle['terminate']>>
}

function fakeChild(): FakeChild {
  const done = Promise.withResolvers<SubprocessOutcome>()
  let settled = false
  const exit = (outcome: SubprocessOutcome = { exitCode: 0, signal: null }): void => {
    if (settled) return
    settled = true
    done.resolve(outcome)
  }
  const terminate = vi.fn<SubprocessHandle['terminate']>(() => { exit({ exitCode: null, signal: 'SIGTERM' }) })
  return {
    exit,
    terminate,
    handle: {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: undefined,
      collected: {},
      done: done.promise,
      terminate,
      waitForExit: vi.fn(async () => { await done.promise; return true }),
    },
  }
}

function fakeClient() {
  return {
    initialize: vi.fn(async () => {}),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    interruptTurn: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTurn: vi.fn(() => () => {}),
    close: vi.fn(),
  }
}

describe('CodexAppServerSupervisor', () => {
  it('shares one initialized generation and restarts after its process exits', async () => {
    const children: FakeChild[] = []
    const clients: ReturnType<typeof fakeClient>[] = []
    const specs: SubprocessSpawnSpec[] = []
    const host = {
      spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
        specs.push(spec)
        const child = fakeChild()
        children.push(child)
        return child.handle
      },
    }
    const supervisor = new CodexAppServerSupervisor(host, {
      cwd: '/workspace',
      graceMs: 100,
      argv: ['/codex', 'app-server', '--stdio'],
      createClient: () => {
        const client = fakeClient()
        clients.push(client)
        return client
      },
    })

    const first = await supervisor.connect()
    expect(await supervisor.connect()).toBe(first)
    expect(children).toHaveLength(1)
    expect(clients[0]?.initialize).toHaveBeenCalledOnce()

    children[0]?.exit({ exitCode: 9, signal: null })
    await expect(first.failure).rejects.toThrow('generation 1 exited')
    const second = await supervisor.connect()

    expect(second.generation).toBe(2)
    expect(children).toHaveLength(2)
    expect(specs[0]).toMatchObject({ cwd: '/workspace', graceMs: 100 })

    await supervisor.dispose()
    expect(children[1]?.terminate).toHaveBeenCalledOnce()
    expect(clients[1]?.close).toHaveBeenCalled()
  })
})
