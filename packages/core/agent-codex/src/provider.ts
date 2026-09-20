/** Cordis provider wiring the Codex driver into the shared Agent lifecycle. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AgentDriver, AgentDriverFactory, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CodexAgent } from './agent.ts'
import { codexThreadBindingProjectionDefinition } from './projection.ts'
import { CODEX_PROTOCOL_VERSION, type CodexInteractionHandler } from './protocol.ts'
import { codexAppServerArgv, CodexAppServerSupervisor } from './supervisor.ts'

export interface Config {
  /** Absolute path to the Codex binary built from the deployment fork. */
  binaryPath?: string
  /** Git commit of the deployment fork; persisted in every thread binding. */
  runtimeRevision?: string
  /** Process cwd and fallback workspace for sessions without a durable cwd. */
  cwd?: string
  /** Native Codex approval policy. Safe unattended default is `never`. */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  /** Native Codex sandbox mode. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Process-tree termination grace. */
  disposeGraceMs?: number
  /** Per-turn timeout; zero disables it. */
  turnTimeoutMs?: number
  /** Deliberate environment overlay after DSH's shared scrub. */
  env?: Record<string, string>
}

/** Full-agent Codex provider; AgentLoop remains the sole lifecycle factory. */
export class CodexAgentProvider extends Service implements AgentDriverFactory {
  static inject = ['agents', 'subprocess', 'sessionProjections']

  static Config = z.object({
    binaryPath: z.string().default(process.env.DSH_CODEX_BIN ?? '/opt/codex/bin/codex'),
    runtimeRevision: z.string().default(process.env.DSH_CODEX_REVISION ?? ''),
    cwd: z.string().default(process.cwd()),
    approvalPolicy: z.union([
      z.const('untrusted'), z.const('on-failure'), z.const('on-request'), z.const('never'),
    ]).default('never'),
    sandbox: z.union([
      z.const('read-only'), z.const('workspace-write'), z.const('danger-full-access'),
    ]).default('workspace-write'),
    disposeGraceMs: z.number().min(1).step(1).default(3_000),
    turnTimeoutMs: z.number().min(0).step(1).default(0),
    env: z.dict(String).default({}),
  }) as z<Required<Config>>

  private readonly supervisor: CodexAppServerSupervisor
  private readonly config: Required<Config>
  private readonly agentsByThread = new Map<string, CodexAgent>()
  readonly catalog = {
    name: 'OpenAI Codex (DSH fork)',
    models: [{
      id: 'codex-default',
      name: 'Codex (configured model)',
      description: 'Model selected by the Codex configuration bundled with DSH.',
      inputModalities: ['text', 'image'] as const,
      reasoning: {
        efforts: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, name: id })),
      },
    }],
  } as const

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentCodex')
    this.config = {
      binaryPath: config.binaryPath ?? process.env.DSH_CODEX_BIN ?? '/opt/codex/bin/codex',
      runtimeRevision: config.runtimeRevision ?? process.env.DSH_CODEX_REVISION ?? '',
      cwd: config.cwd ?? process.cwd(),
      approvalPolicy: config.approvalPolicy ?? 'never',
      sandbox: config.sandbox ?? 'workspace-write',
      disposeGraceMs: config.disposeGraceMs ?? 3_000,
      turnTimeoutMs: config.turnTimeoutMs ?? 0,
      env: config.env ?? {},
    }
    if (!this.config.binaryPath.startsWith('/')) {
      throw new Error('agent-codex: binaryPath must be absolute')
    }
    if (this.config.runtimeRevision.trim().length === 0) {
      throw new Error('agent-codex: runtimeRevision (or DSH_CODEX_REVISION) is required')
    }
    const interactions: CodexInteractionHandler = (method, params) => {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
      const agent = threadId === undefined ? undefined : this.agentsByThread.get(threadId)
      if (agent === undefined) {
        return Promise.reject(new Error('agent-codex: server request referenced an unknown thread'))
      }
      return agent.handleInteraction(method, params)
    }
    this.supervisor = new CodexAppServerSupervisor(ctx.subprocess, {
      cwd: this.config.cwd,
      env: this.config.env,
      graceMs: this.config.disposeGraceMs,
      argv: codexAppServerArgv(this.config.binaryPath),
      interactions,
    })
    ctx.sessionProjections.register(codexThreadBindingProjectionDefinition)
    ctx.effect(() => ctx.agents.setDriverFactory('codex', this), 'agentCodex.setDriverFactory()')
    ctx.effect(() => () => this.supervisor.dispose(), 'agentCodex.supervisor()')
  }

  createDriver(ctx: Context, id: SessionId, options: AgentOptions, session: Session): AgentDriver {
    const cwd = session.header.cwd ?? this.config.cwd
    const agent = new CodexAgent(ctx, id, options, session, this.supervisor, {
      cwd,
      ...options.model === undefined || options.model === 'codex-default' ? {} : { model: options.model },
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.sandbox,
      ...this.config.approvalPolicy === 'on-request' ? { approvalsReviewer: 'user' as const } : {},
    }, this.config.turnTimeoutMs, (threadId, owner) => {
      if (this.agentsByThread.has(threadId)) {
        throw new Error(`agent-codex: thread ${JSON.stringify(threadId)} is already attached`)
      }
      this.agentsByThread.set(threadId, owner)
      return () => {
        if (this.agentsByThread.get(threadId) === owner) this.agentsByThread.delete(threadId)
      }
    }, `protocol:${CODEX_PROTOCOL_VERSION};fork:${this.config.runtimeRevision}`)
    return {
      agent,
      start: (source, signal) => agent.start(source, signal),
      dispose: () => agent.dispose(),
    }
  }
}

export default CodexAgentProvider
