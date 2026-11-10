/** Cordis provider wiring the Codex driver into the shared Agent lifecycle. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { AgentDriver, AgentDriverFactory, AgentDriverRoute, AgentDriverSelector, AgentOptions } from '@deepseek-ai/dsh-agent'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import { PiAiProviderProfileSchema } from '@deepseek-ai/dsh-llm-pi-ai'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-settings'
import { CodexAgent } from './agent.ts'
import { ensureCodexCheckpointCleanup } from './checkpoint-stream.ts'
import {
  assertCodexGatewayServiceable,
  CodexModelGateway,
  codexGatewayModelId,
  codexGatewayModels,
} from './model-gateway.ts'
import type { CodexGatewayAuditWriter, CodexModelGatewayConfig, CodexProviderProfile } from './model-gateway.ts'
import { codexThreadBindingProjectionDefinition } from './projection.ts'
import { codexTransferSource } from './portable-source.ts'
import { createCodexImportedAgent } from './portable-import.ts'
import type { ImportedAgentOptions } from '@deepseek-ai/dsh-agent'
import type { CodexImportPreparation } from './portable-target.ts'
import { codexTransferTarget } from './portable-target.ts'
import { CODEX_PROTOCOL_VERSION, type CodexInteractionHandler } from './protocol.ts'
import { codexAppServerArgv, CodexAppServerSupervisor } from './supervisor.ts'

/** Deployment configuration for the Codex full-agent provider. */
export interface Config {
  /** Optional display label for the Codex agent. */
  label?: string
  /** Absolute path to the Codex binary built from the deployment fork. */
  binaryPath?: string
  /** Git commit of the deployment fork; persisted in every thread binding. */
  runtimeRevision?: string
  /** Process cwd and fallback workspace for sessions without a durable cwd. */
  cwd?: string
  /** Native Codex approval policy. Safe unattended default is `never`. */
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  /** Process-tree termination grace. */
  disposeGraceMs?: number
  /** Per-turn timeout; zero disables it. */
  turnTimeoutMs?: number
  /** Deliberate environment overlay after DSH's shared scrub. */
  env?: Record<string, string>
  /** Model routes owned by the full Codex agent. */
  providers?: Record<string, CodexProviderProfile>
  /** Use Codex for new sessions whose selected model has a Codex route. */
  enabled?: boolean
}

const CODEX_GATEWAY_API_KEY_ENV = 'DSH_CODEX_GATEWAY_TOKEN'
const CODEX_REQUEST_LOG_DIR = '/opt/dsh-codex-requests'
const CodexProviderProfileSchema = z.intersect([
  PiAiProviderProfileSchema,
  z.object({ apiFormat: z.union(['chat-completions', 'responses']).default('chat-completions') }),
]) as z<CodexProviderProfile>
interface CodexSettings extends CodexModelGatewayConfig {
  label?: string
  enabled: boolean
}
const CodexModelGatewaySchema: z<CodexSettings> = z.object({
  label: z.string(),
  enabled: z.boolean().default(false),
  providers: z.dict(CodexProviderProfileSchema).default({}),
})

interface ResolvedConfig extends Omit<Required<Config>, 'providers' | 'label'> {
  label?: string
  providers: Record<string, CodexProviderProfile>
}

/** Full-agent Codex provider; AgentLoop remains the sole lifecycle factory. */
export class CodexAgentProvider extends Service implements AgentDriverFactory, AgentDriverSelector {
  readonly driverId = 'codex'
  static inject = ['agents', 'attachments', 'llm', 'subprocess', 'sessionProjections', 'sessions']

  static Config = z.object({
    label: z.string(),
    binaryPath: z.string().default(process.env.DSH_CODEX_BIN ?? '/opt/codex/bin/codex'),
    runtimeRevision: z.string().default(process.env.DSH_CODEX_REVISION ?? ''),
    cwd: z.string().default(process.cwd()),
    approvalPolicy: z.union([
      z.const('untrusted'), z.const('on-failure'), z.const('on-request'), z.const('never'),
    ]).default('never'),
    disposeGraceMs: z.number().min(1).step(1).default(3_000),
    turnTimeoutMs: z.number().min(0).step(1).default(0),
    env: z.dict(String).default({}),
    enabled: z.boolean().default(false),
    providers: z.dict(CodexProviderProfileSchema).default({}),
  }) as z<Config>

  private readonly supervisor: CodexAppServerSupervisor
  private readonly gateway: CodexModelGateway
  private readonly config: ResolvedConfig
  private gatewayConfig: () => CodexModelGatewayConfig
  private settingsSource: () => CodexSettings
  private readonly agentsByThread = new Map<string, CodexAgent>()
  private readonly catalogRoutes = new Map<string, () => void>()
  private configurableProviders: ReturnType<LlmRuntime['registerConfigurableProviders']> | undefined

  get catalog() {
    return { name: 'OpenAI Codex (DSH fork)', models: codexGatewayModels(this.gatewayConfig()) }
  }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentCodex')
    this.config = {
      binaryPath: config.binaryPath ?? process.env.DSH_CODEX_BIN ?? '/opt/codex/bin/codex',
      runtimeRevision: config.runtimeRevision ?? process.env.DSH_CODEX_REVISION ?? '',
      cwd: config.cwd ?? process.cwd(),
      approvalPolicy: config.approvalPolicy ?? 'never',
      disposeGraceMs: config.disposeGraceMs ?? 3_000,
      turnTimeoutMs: config.turnTimeoutMs ?? 0,
      env: config.env ?? {},
      enabled: config.enabled ?? false,
      ...(config.label === undefined ? {} : { label: config.label }),
      providers: config.providers ?? {},
    }
    if (!this.config.binaryPath.startsWith('/')) {
      throw new Error('agent-codex: binaryPath must be absolute')
    }
    if (this.config.runtimeRevision.trim().length === 0) {
      throw new Error('agent-codex: runtimeRevision (or DSH_CODEX_REVISION) is required')
    }
    void ensureCodexCheckpointCleanup().catch((cause: unknown) => {
      ctx.logger.error(`agent-codex: stale checkpoint cleanup failed: ${String(cause)}`)
    })
    this.settingsSource = () => ({
      enabled: this.config.enabled,
      ...(this.config.label === undefined ? {} : { label: this.config.label }),
      providers: this.config.providers,
    })
    this.gatewayConfig = () => ({ providers: this.settingsSource().providers ?? {} })
    assertCodexGatewayServiceable(this.gatewayConfig())
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, 'codex', CodexModelGatewaySchema, {
        enabled: this.config.enabled,
        ...(this.config.label === undefined ? {} : { label: this.config.label }),
        providers: this.config.providers,
      }, {
        validate: assertCodexGatewayServiceable,
        setSource: (source) => {
          this.settingsSource = source
        },
        onChange: () => { this.syncCatalogRoutes(ctx) },
      })
    })
    const logRequests = /^(true|1|yes|on)$/i.test(process.env.CODEX_LOG_REQUESTS?.trim() ?? '')
    const audit: CodexGatewayAuditWriter = async (binding, entry) => {
      const agent = this.agentsByThread.get(binding.threadId)
      if (agent === undefined || agent.id !== binding.dshSessionId) {
        throw new Error('agent-codex: model audit lost its owning Session')
      }
      agent.session.append('codex/model-audit', {
        version: 1,
        turn: binding.dshTurn,
        attemptId: binding.attemptId,
        purpose: binding.purpose,
        phase: entry.phase,
        payload: entry.payload,
      })
      if (!await ctx.sessions.flush(agent.session)) {
        throw new Error('agent-codex: durable Session audit storage is unavailable')
      }
    }
    this.gateway = new CodexModelGateway(
      ctx, () => this.gatewayConfig(),
      metadata => this.agentsByThread.get(metadata.threadId)?.bindModelAttempt(metadata),
      audit,
      this.config.env,
      logRequests ? CODEX_REQUEST_LOG_DIR : undefined,
    )
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
      env: { ...this.config.env, DSH_CODEX_REVISION: this.config.runtimeRevision,
        [CODEX_GATEWAY_API_KEY_ENV]: this.gateway.token },
      graceMs: this.config.disposeGraceMs,
      argv: async () => codexAppServerArgv(this.config.binaryPath, {
        baseURL: await this.gateway.ready,
        apiKeyEnv: CODEX_GATEWAY_API_KEY_ENV,
      }),
      interactions,
    })
    ctx.sessionProjections.register(codexThreadBindingProjectionDefinition)
    ctx.effect(() => ctx.agents.setTransferPorts('codex', {
      source: codexTransferSource(async (id) => {
        const live = ctx.sessions.get(id)
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) return live
        if (live !== undefined && !await ctx.sessions.flush(live)) {
          throw new Error('agent-codex: source Session flush failed before transfer')
        }
        let handle: SessionHandle
        try {
          handle = await persistence.open(id, 'read')
        } catch (cause: unknown) {
          if (cause instanceof SessionPersistenceNotFoundError) return live
          throw cause
        }
        try {
          return Session.fromRestore(id, await handle.read(), handle.header, handle.inheritedEventCount)
        } finally {
          await handle.close()
        }
      }, ctx.attachments),
      target: { ...codexTransferTarget(() => Object.entries(this.gatewayConfig().providers ?? {})
        .flatMap(([provider, profile]) => codexGatewayModels({ providers: { [provider]: profile } })
          .map(model => ({ provider: `codex:${provider}`, id: model.id }))),
      () => this.config.runtimeRevision, model => this.gateway.describeAuthentication(model.id)),
      createImportedAgent: (preparation: CodexImportPreparation, options?: ImportedAgentOptions) =>
        createCodexImportedAgent(ctx, preparation, options),
      },
    }), 'agentCodex.transferPorts()')
    ctx.effect(() => ctx.agents.setDriverFactory('codex', {
      driverId: 'codex',
      catalog: { name: 'OpenAI Codex (DSH fork)', models: [] },
      createDriver: (driverCtx, id, options, session) => this.createDriver(driverCtx, id, options, session),
    }), 'agentCodex.setDriverFactory()')
    this.syncCatalogRoutes(ctx)
    ctx.effect(() => () => {
      for (const dispose of this.catalogRoutes.values()) dispose()
      this.catalogRoutes.clear()
      this.configurableProviders?.()
      this.configurableProviders = undefined
    }, 'agentCodex.catalogRoutes()')
    ctx.effect(() => ctx.agents.setDriverSelector(this), 'agentCodex.setDriverSelector()')
    ctx.effect(() => async () => {
      await this.supervisor.dispose()
      await this.gateway.dispose()
    }, 'agentCodex.runtime()')
  }

  private syncCatalogRoutes(ctx: Context): void {
    const providers = this.gatewayConfig().providers ?? {}
    for (const [provider, dispose] of this.catalogRoutes) {
      if (provider in providers) continue
      dispose()
      this.catalogRoutes.delete(provider)
    }
    for (const provider of Object.keys(providers)) {
      if (this.catalogRoutes.has(provider)) continue
      const profileForRoute = () => this.gatewayConfig().providers?.[provider]
      const labelForRoute = () => this.settingsSource().label ?? 'codex'
      const factory: AgentDriverFactory = {
        driverId: 'codex',
        get catalog() {
          const profile = profileForRoute()
          return {
            name: `${labelForRoute()}: ${profile?.displayName ?? provider}`,
            models: profile === undefined ? [] : codexGatewayModels({ providers: { [provider]: profile } })
              .map(({ description: _description, ...model }) => ({
                ...model, name: `${labelForRoute()}: ${model.name}`,
              })),
          }
        },
        createDriver: (driverCtx, id, options, session) => {
          const route = options.model
          const profile = profileForRoute()
          if (route === undefined || profile === undefined
            || !codexGatewayModels({ providers: { [provider]: profile } }).some(model => model.id === route)) {
            throw new Error(`agent-codex: model ${JSON.stringify(route)} is not configured`)
          }
          return this.createDriver(driverCtx, id, { ...options, provider: 'codex' }, session)
        },
      }
      this.catalogRoutes.set(provider, ctx.agents.setDriverFactory(`codex:${provider}`, factory))
    }
    const label = this.settingsSource().label ?? 'codex'
    const entries = Object.entries(providers).sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, profile]) => ({
        provider: `codex:${provider}`,
        displayName: `${label}: ${profile.displayName ?? provider}`,
        settingsNs: 'codex',
        settingsPath: ['providers', provider],
        declared: true,
      }))
    if (this.configurableProviders === undefined && entries.length > 0) {
      this.configurableProviders = ctx.llm.registerConfigurableProviders(entries)
    } else if (this.configurableProviders !== undefined) {
      // Model-only edits leave directory entries unchanged, but still require
      // an adapters-updated event after the resolved settings commit so every
      // picker reloads the live driver catalog.
      this.configurableProviders.replace(entries)
    }
  }

  createDriver(ctx: Context, id: SessionId, options: AgentOptions, session: Session): AgentDriver {
    const cwd = session.header.cwd ?? this.config.cwd
    const model = options.model ?? this.catalog.models[0]?.id
    if (model === undefined) {
      throw new Error('agent-codex: no models are configured under codex.providers')
    }
    const agent = new CodexAgent(ctx, id, options, session, this.supervisor, {
      cwd,
      model,
      approvalPolicy: this.config.approvalPolicy,
      sandbox: 'danger-full-access',
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
      driverId: 'codex',
      agent,
      start: (source, signal) => agent.start(source, signal),
      dispose: () => agent.dispose(),
    }
  }

  /** Select Codex for the requested lifecycle intent when its model route is configured.
   * @param ctx - lifecycle context supplied to Codex.
   * @param id - shared Agent and Session identity.
   * @param options - selected provider and model.
   * @param session - prepared Session whose durable selection may constrain resume.
   * @param selectionRoute - creation, resume, or explicit import intent.
   * @returns the Codex driver, or undefined when the standard loop owns the route.
   */
  selectDriver(
    ctx: Context, id: SessionId, options: AgentOptions, session: Session, selectionRoute: AgentDriverRoute,
  ): AgentDriver | undefined {
    if (selectionRoute.kind !== 'create' && selectionRoute.driverId === 'standard') return undefined
    const provider = options.provider
    const model = options.model
    if (provider === undefined || model === undefined) return undefined
    const events = session.snapshotEvents()
    const selectedDriver = events.find(event => event.type === 'agent/driver-selected')
    if (selectedDriver?.type === 'agent/driver-selected' && selectedDriver.data.driverId !== 'codex') return undefined
    const hasCodexThread = events.some(event => event.type === 'codex/thread-bound')
    if (!hasCodexThread) {
      if (selectedDriver === undefined && selectionRoute.kind !== 'import' && !this.settingsSource().enabled) return undefined
      if (selectedDriver === undefined && selectionRoute.kind !== 'import' && events.some(event => event.type === 'turn/start')) return undefined
    }
    const modelRoute = codexGatewayModelId(provider, model)
    if (!codexGatewayModels(this.gatewayConfig()).some(candidate => candidate.id === modelRoute)) {
      if (selectionRoute.kind !== 'create' || hasCodexThread) throw new Error(`agent-codex: selected driver requires configured model ${JSON.stringify(modelRoute)}`)
      return undefined
    }
    return this.createDriver(ctx, id, { ...options, provider: 'codex', model: modelRoute }, session)
  }
}

export default CodexAgentProvider
