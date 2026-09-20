/** Shared, restartable process owner for the official Codex app-server. */

import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { CodexAppServerClient } from './client.ts'
import type {
  CodexAppServer,
  CodexInteractionHandler,
} from './protocol.ts'

/** Explicit fork binary command, independent of npm and the host PATH. */
export function codexAppServerArgv(binaryPath: string): readonly string[] {
  return [binaryPath, 'app-server', '--stdio']
}

/** One live process generation shared by all attached Codex agents. */
export interface CodexAppServerConnection {
  readonly generation: number
  readonly client: CodexAppServer
  /** Rejects as soon as this exact process generation exits or fails. */
  readonly failure: Promise<never>
}

/** Process operations injected from `ctx.subprocess`. */
export interface CodexAppServerProcessHost {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export interface CodexAppServerSupervisorOptions {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly graceMs: number
  readonly interactions?: CodexInteractionHandler
  /** Exact command. Production passes the image-bundled fork binary. */
  readonly argv: readonly string[]
  /** Test seam around the stream client constructor. */
  readonly createClient?: (
    child: SubprocessHandle,
    interactions?: CodexInteractionHandler,
  ) => CodexAppServer
}

interface Generation extends CodexAppServerConnection {
  readonly child: SubprocessHandle
  stopped: boolean
}

function processFailure(generation: number, outcome: SubprocessOutcome): Error {
  return new Error(
    `agent-codex: app-server generation ${generation} exited `
    + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
  )
}

/**
 * Owns at most one app-server process. Concurrent callers share startup;
 * after a crash, the next `connect()` starts a fresh initialized generation.
 */
export class CodexAppServerSupervisor {
  private generation = 0
  private current: Generation | undefined
  private starting: Promise<Generation> | undefined
  private disposed = false

  constructor(
    private readonly host: CodexAppServerProcessHost,
    private readonly options: CodexAppServerSupervisorOptions,
  ) {}

  async connect(signal?: AbortSignal): Promise<CodexAppServerConnection> {
    if (this.disposed) throw new Error('agent-codex: app-server supervisor is disposed')
    if (this.current !== undefined && !this.current.stopped) return this.current
    if (this.starting === undefined) {
      const starting = this.startGeneration(signal)
      this.starting = starting
      void starting.finally(() => {
        if (this.starting === starting) this.starting = undefined
      }).catch(() => {})
    }
    return this.starting
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const starting = this.starting
    const current = this.current
    const generation = current ?? await starting?.catch(() => undefined)
    if (generation !== undefined) await this.stopGeneration(generation)
  }

  private async startGeneration(signal?: AbortSignal): Promise<Generation> {
    signal?.throwIfAborted()
    const generation = ++this.generation
    const child = this.host.spawn({
      argv: this.options.argv,
      cwd: this.options.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.options.graceMs,
      ...this.options.env === undefined ? {} : { env: this.options.env },
      ...signal === undefined ? {} : { signal },
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      child.terminate()
      throw new Error('agent-codex: app-server did not expose protocol pipes')
    }
    const client = this.options.createClient?.(child, this.options.interactions)
      ?? CodexAppServerClient.fromStreams(child.stdout, child.stdin, this.options.interactions)
    const failed = Promise.withResolvers<never>()
    void failed.promise.catch(() => {})
    const live: Generation = { generation, child, client, failure: failed.promise, stopped: false }
    void child.done.then(
      (outcome) => {
        live.stopped = true
        client.close()
        if (this.current === live) this.current = undefined
        failed.reject(processFailure(generation, outcome))
      },
      (error: unknown) => {
        live.stopped = true
        client.close()
        if (this.current === live) this.current = undefined
        failed.reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
    try {
      await Promise.race([client.initialize(signal), failed.promise])
      if (this.disposed) throw new Error('agent-codex: app-server supervisor disposed during startup')
      this.current = live
      return live
    } catch (error: unknown) {
      await this.stopGeneration(live).catch(() => {})
      throw error
    }
  }

  private async stopGeneration(generation: Generation): Promise<void> {
    generation.client.close()
    if (!generation.stopped) {
      try { generation.child.stdin?.end() } catch {}
      generation.child.terminate()
      await generation.child.waitForExit()
      await generation.child.done.catch(() => {})
      generation.stopped = true
    }
    if (this.current === generation) this.current = undefined
  }
}
