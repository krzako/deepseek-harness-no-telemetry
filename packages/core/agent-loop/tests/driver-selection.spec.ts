import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { AgentDriverRoute } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceNotFoundError, SessionPersistenceRevision,
  type SessionAccess, type SessionHandle, type SessionPersistenceSnapshot, type SessionImportTransaction,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentLoop from '../src/index.ts'
import { ReactLoopAgent } from '../src/agent.ts'

const stored = new Map<string, { header: SessionHeader; events: SessionEvent[] }>()
const contexts: Context[] = []
const started: string[] = []
const routes: AgentDriverRoute[] = []
const flushed = new Set<string>()
let failFlush = false

class MemoryPersistence extends SessionPersistence {
  private handle(header: SessionHeader, access: SessionAccess): SessionHandle {
    const entry = stored.get(header.id)
    if (entry === undefined) throw new SessionPersistenceNotFoundError(header.id)
    const handle: SessionHandle = {
      id: header.id, header, access, inheritedEventCount: SessionLogOffset(0),
      read: async (offset = 0, length) => structuredClone(entry.events.slice(offset, length === undefined ? undefined : offset + length)),
      append: async (events) => { entry.events.push(...structuredClone(events)) },
      flush: async () => {
        if (failFlush) throw new Error('driver selection durability failed')
        flushed.add(header.id)
      },
      close: async () => {},
      [Symbol.asyncDispose]: async () => { await handle.close() },
    }
    return handle
  }

  create(header: SessionHeader): Promise<SessionHandle> {
    if (stored.has(header.id)) throw new Error('duplicate Session')
    stored.set(header.id, { header: structuredClone(header), events: [] })
    return Promise.resolve(this.handle(header, 'write'))
  }

  override async beginImport(header: SessionHeader): Promise<SessionImportTransaction> {
    const handle = await this.create(header)
    return { handle, publish: async (publish) => { await handle.flush(); return publish() },
      rollback: async () => { await handle.close(); stored.delete(header.id) } }
  }

  open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const entry = stored.get(id)
    if (entry === undefined) throw new SessionPersistenceNotFoundError(id)
    return Promise.resolve(this.handle(structuredClone(entry.header), access))
  }

  flush(): Promise<void> { return Promise.resolve() }

  stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = stored.get(id)
    return Promise.resolve(entry === undefined ? undefined : {
      header: structuredClone(entry.header), revision: SessionPersistenceRevision(String(entry.events.length)),
    })
  }

  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([...stored.values()].map(entry => ({
      header: structuredClone(entry.header), revision: SessionPersistenceRevision(String(entry.events.length)),
    })))
  }
}

async function mount(enabled: boolean, withSelector = true, driverId = 'codex'): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryPersistence)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (withSelector && driverId !== 'standard') ctx.agents.setTransferPorts(driverId, {
    source: { driverId, exportArchivedContext: vi.fn(), exportPortableContext: vi.fn() },
    target: { driverId, importCapabilities: vi.fn(), describeAuthentication: vi.fn(),
      importPortableContext: vi.fn(), createImportedAgent: vi.fn() },
  })
  if (withSelector) ctx.agents.setDriverSelector({
    driverId,
    selectDriver(driverCtx, id, options, session, route) {
      routes.push(route)
      const saved = session.snapshotEvents().find(event => event.type === 'agent/driver-selected')
      if (!enabled && route.kind !== 'import' && (saved?.type !== 'agent/driver-selected' || saved.data.driverId !== 'codex')) return undefined
      const agent = new ReactLoopAgent(driverCtx, id, options, session)
      return {
        driverId, agent, start: async () => {
          if (!flushed.has(id)) throw new Error('driver started before selection was durable')
          started.push(id)
        },
        dispose: async () => {
          agent.cancel({ kind: 'disposed' })
          await agent.whenIdle()
          await agent.scope.dispose()
        },
      }
    },
  })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  stored.clear()
  started.length = 0
  routes.length = 0
  flushed.clear()
  failFlush = false
})

describe('durable agent driver selection', () => {
  it('restores a literal imported standard prompt after resume and rejects conflicting setup', async () => {
    const sessionId = SessionId('standard-import-resume')
    const seedSource = Session.create(sessionId)
    seedSource.append('agent/driver-selected', { version: 1, driverId: 'standard' })
    seedSource.append('turn/start', { turn: 1 })
    seedSource.append('step/start', { turn: 1, step: 1 })
    seedSource.append('request/header', {
      reason: 'initial', header: { config: { provider: 'mock', model: 'shared-name' }, system: 'Keep {{source}} literal.' },
    })
    seedSource.append('step/end', { turn: 1, step: 1 })
    seedSource.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const meta = { importLineage: { sourceSessionId: SessionId('old-standard'), sourceDriverId: 'standard', importId: 'transfer-1' } }
    const first = await mount(false)
    const created = await first.agents.create({
      sessionId, seed: seedSource.snapshotEvents(), meta,
      route: { kind: 'import', driverId: 'standard' },
      agentOptions: { provider: 'mock', model: 'shared-name' },
    })
    expect(renderPrompt(await first.systemPrompt.assemble(assembleContextFor(created.agent))))
      .toBe('Keep {{source}} literal.')
    await created.dispose()
    await first.fiber.dispose()
    const second = await mount(false, false)
    const resumed = await second.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'shared-name' },
    })
    expect(renderPrompt(await second.systemPrompt.assemble(assembleContextFor(resumed.agent))))
      .toBe('Keep {{source}} literal.')
    await resumed.dispose()

    await expect(second.agents.create({
      sessionId: SessionId('standard-import-conflict'), seed: seedSource.snapshotEvents(), meta,
      route: { kind: 'import', driverId: 'standard' },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({ name: 'conflicting-system', order: 0, text: 'different', complete: true })
      },
    })).rejects.toThrow(/multiple complete prompt sections/)
    expect(second.agents.get(SessionId('standard-import-conflict'))).toBeUndefined()
  })

  it('routes a new imported Session to the named driver regardless of creation policy', async () => {
    const ctx = await mount(false)
    const sessionId = SessionId('driver-import-codex')
    const handle = await ctx.agents.create({
      sessionId,
      route: { kind: 'import', driverId: 'codex' },
      meta: { importLineage: { sourceSessionId: SessionId('source-codex'), sourceDriverId: 'standard', importId: 'transfer-1' } },
      agentOptions: { provider: 'mock', model: 'shared-name' },
    })
    expect(routes).toContainEqual({ kind: 'import', driverId: 'codex' })
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'agent/driver-selected'))
      .toMatchObject([{ data: { version: 1, driverId: 'codex' } }])
    expect(started).toContain(sessionId)
    expect(stored.get(sessionId)?.header.importLineage).toEqual({
      sourceSessionId: 'source-codex', sourceDriverId: 'standard', importId: 'transfer-1',
    })
    await handle.dispose()
    await ctx.fiber.dispose()
    const resumedCtx = await mount(false)
    const resumed = await resumedCtx.agents.resume({
      resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'shared-name' },
    })
    expect(resumed.agent.session.header.importLineage).toEqual({
      sourceSessionId: 'source-codex', sourceDriverId: 'standard', importId: 'transfer-1',
    })
    await resumed.dispose()
  })

  it('keeps an imported standard Session on the standard loop and rejects conflicting seed identity', async () => {
    const ctx = await mount(true)
    const standard = await ctx.agents.create({
      sessionId: SessionId('driver-import-standard'),
      route: { kind: 'import', driverId: 'standard' },
      meta: { importLineage: { sourceSessionId: SessionId('source-standard'), sourceDriverId: 'codex', importId: 'transfer-2' } },
      agentOptions: { provider: 'mock', model: 'shared-name' },
    })
    expect(standard.agent.session.snapshotEvents().find(event => event.type === 'agent/driver-selected')?.data)
      .toEqual({ version: 1, driverId: 'standard' })
    expect(started).toEqual([])
    await standard.dispose()

    const source = Session.create(SessionId('driver-import-source'))
    source.append('agent/driver-selected', { version: 1, driverId: 'standard' })
    const seed = source.snapshotEvents()
    await expect(ctx.agents.create({
      sessionId: SessionId('driver-import-conflict'), seed,
      route: { kind: 'import', driverId: 'codex' },
      meta: { importLineage: { sourceSessionId: SessionId('source-standard'), sourceDriverId: 'standard', importId: 'transfer-3' } },
      agentOptions: { provider: 'mock', model: 'shared-name' },
    })).rejects.toThrow(/requires driver "standard", got "codex"/)
    expect(ctx.agents.get(SessionId('driver-import-conflict'))).toBeUndefined()
  })

  it('requires route and lineage together for imports', async () => {
    const ctx = await mount(false)
    await expect(ctx.agents.create({
      sessionId: SessionId('import-without-lineage'), route: { kind: 'import', driverId: 'codex' },
    })).rejects.toThrow(/route and Session import lineage must be supplied together/)
    await expect(ctx.agents.create({
      sessionId: SessionId('lineage-without-import'),
      meta: { importLineage: { sourceSessionId: SessionId('source'), sourceDriverId: 'standard', importId: 'transfer-4' } },
    })).rejects.toThrow(/route and Session import lineage must be supplied together/)
  })

  it('resumes the stored driver after enabled changes without confusing it with the model provider', async () => {
    const sessionId = SessionId('driver-resume')
    const first = await mount(true)
    const created = await first.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'shared-name' } })
    expect(started).toEqual([sessionId])
    expect(routes).toEqual([{ kind: 'create' }])
    expect(created.agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'agent/driver-selected', data: { version: 1, driverId: 'codex' },
    }))
    await created.dispose()
    await first.fiber.dispose()
    flushed.clear()

    const disabled = await mount(false)
    const resumed = await disabled.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'shared-name' } })
    expect(routes.at(-1)).toEqual({ kind: 'resume', driverId: 'codex' })
    expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'agent/driver-selected')).toHaveLength(1)
    await resumed.dispose()
    await disabled.fiber.dispose()

    const unavailable = await mount(false, false)
    await expect(unavailable.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'shared-name' } }))
      .rejects.toThrow(/requires driver "codex", got "standard"/)
  })

  it('does not start an external driver when its selection cannot be flushed', async () => {
    const ctx = await mount(true)
    failFlush = true
    await expect(ctx.agents.create({
      sessionId: SessionId('driver-flush-failed'), agentOptions: { provider: 'mock', model: 'shared-name' },
    })).rejects.toThrow('driver selection durability failed')
    expect(started).toEqual([])
  })

  it('reserves the built-in driver id for the standard loop', async () => {
    await expect(mount(true, true, 'standard')).rejects.toThrow('non-reserved driver id')
    expect(started).toEqual([])
  })
})
