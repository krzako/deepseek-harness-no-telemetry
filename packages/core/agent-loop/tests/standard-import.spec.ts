import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  prepareAgentTransfer, standardTransferSource, standardTransferTarget,
  type Agent, type StandardImportPreparation,
} from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop, { createStandardImportedAgent } from '../src/index.ts'
import { ReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('standard imported Agent', () => {
  it('starts a new Session with old context but does not re-execute old model work', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('old answer'), textResponse('new answer')])
    const models = vi.spyOn(adapter, 'listModels').mockResolvedValue([{ provider: 'mock', id: 'model', name: 'model' }])
    ctx.llm.registerAdapter(['mock'], adapter)
    const authentication = vi.spyOn(adapter, 'describeAuthentication').mockResolvedValue({ status: 'missing', reference: 'MOCK_KEY' })
    await expect(ctx.agents.getTransferPorts('standard').target.describeAuthentication({ provider: 'mock', id: 'model' }))
      .resolves.toEqual({ status: 'missing', reference: 'MOCK_KEY' })
    expect(authentication).toHaveBeenCalledWith('mock', 'model')

    try {
      const sourceId = SessionId('standard-transfer-source')
      const targetId = SessionId('standard-transfer-target')
      const source = await ctx.agents.create({
        sessionId: sourceId, agentOptions: { provider: 'mock', model: 'model' },
        setup(agentCtx) {
          agentCtx.systemPrompt.section({
            name: 'source-system', order: 0, text: 'Source {{unbound}} stays literal.',
            literal: true, complete: true,
          })
        },
      })
      const oldIdle = waitForIdle(ctx, source.agent)
      source.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'old question' }] }))
      await oldIdle
      const ports = ctx.agents.getTransferPorts('standard')
      const reviewed = await prepareAgentTransfer(
        ports.source, ports.target,
        sourceId, targetId, { provider: 'mock', id: 'model' },
      )
      const prepared = await reviewed.commit(true)
      expect(models).toHaveBeenCalledTimes(3)
      const imported = await ports.target.createImportedAgent(prepared)
      expect(adapter.requests).toHaveLength(1)
      expect(imported.agent.session.header.importLineage).toEqual({
        sourceSessionId: sourceId, sourceDriverId: 'standard', importId: reviewed.lineage.importId,
      })
      expect(imported.agent.session.deriveMessages().map(message => message.content)).toEqual(
        source.agent.session.deriveMessages().map(message => message.content),
      )
      const newIdle = waitForIdle(ctx, imported.agent)
      imported.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new question' }] }))
      await newIdle
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]?.system).toBe('Source {{unbound}} stays literal.')
      expect(adapter.requests[1]?.messages.map(message => message.content)).toEqual([
        [{ type: 'text', text: 'old question' }],
        [{ type: 'text', text: 'old answer' }],
        [{ type: 'text', text: 'new question' }],
      ])
      await imported.dispose()
      await source.dispose()
      await loopFiber.dispose()
      expect(() => ctx.agents.getTransferPorts('standard')).toThrow(/unavailable/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('imports a completed tool exchange as history without executing the old call again', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([
      toolCallResponse('old-call', 'counted', { value: 'before' }),
      textResponse('old answer'),
      textResponse('new answer'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    let toolExecutions = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'counted', description: 'count executions',
      parameters: { value: { type: 'string' } },
      async execute(args) {
        toolExecutions++
        return [{ type: 'text', text: `result: ${args.value}` }]
      },
    }))
    try {
      const sourceId = SessionId('standard-tool-transfer-source')
      const source = await ctx.agents.create({
        sessionId: sourceId, agentOptions: { provider: 'mock', model: 'model' },
      })
      const oldIdle = waitForIdle(ctx, source.agent)
      source.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'use counted' }] }))
      await oldIdle
      expect(toolExecutions).toBe(1)
      expect(adapter.requests).toHaveLength(2)

      const targetId = SessionId('standard-tool-transfer-target')
      const reviewed = await prepareAgentTransfer(
        standardTransferSource(id => ctx.sessions.get(id)),
        standardTransferTarget(() => [{ provider: 'mock', id: 'model' }]),
        sourceId, targetId, { provider: 'mock', id: 'model' },
      )
      const imported = await createStandardImportedAgent(ctx, await reviewed.commit(true))
      expect(toolExecutions).toBe(1)
      expect(adapter.requests).toHaveLength(2)
      expect(imported.agent.session.deriveMessages().map(message => message.content)).toEqual(
        source.agent.session.deriveMessages().map(message => message.content),
      )
      expect(imported.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(1)
      expect(imported.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)

      const newIdle = waitForIdle(ctx, imported.agent)
      imported.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }))
      await newIdle
      expect(toolExecutions).toBe(1)
      expect(adapter.requests).toHaveLength(3)
      expect(adapter.requests[2]?.messages.slice(0, -1).map(message => message.content)).toEqual(
        source.agent.session.deriveMessages().map(message => message.content),
      )
      expect(adapter.requests[2]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'continue' }])
      await imported.dispose()
      await source.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rolls back a durable imported seed when the selected driver fails to start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-start-failure-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      await ctx.plugin(AgentLoop, { agents: [] })
      const driverId = 'failing-import-driver'
      ctx.agents.setTransferPorts(driverId, {
        source: { driverId, exportArchivedContext: vi.fn(), exportPortableContext: vi.fn() },
        target: { driverId, importCapabilities: vi.fn(), describeAuthentication: vi.fn(),
          importPortableContext: vi.fn(), createImportedAgent: vi.fn() },
      })
      const dispose = vi.fn()
      ctx.agents.setDriverFactory(driverId, {
        driverId,
        createDriver(driverCtx, id, options, session) {
          const agent = new ReactLoopAgent(driverCtx, id, options, session)
          return { driverId, agent, start: async () => { throw new Error('driver start failure probe') },
            dispose: async () => { dispose(); agent.cancel({ kind: 'disposed' }); await agent.whenIdle(); await agent.scope.dispose() } }
        },
      })
      const id = SessionId('failed-import')
      await expect(ctx.agents.create({ sessionId: id, route: { kind: 'import', driverId },
        meta: { importLineage: { sourceSessionId: SessionId('source'), sourceDriverId: driverId, importId: 'failed-import' } },
        agentOptions: { provider: driverId, model: 'unused' },
      })).rejects.toThrow('driver start failure probe')
      expect(dispose).toHaveBeenCalledOnce()
      expect(ctx.agents.get(id)).toBeUndefined()
      expect(ctx.sessions.get(id)).toBeUndefined()
      expect(await ctx.sessionPersistence.list()).toEqual([])
      expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('exports a completed persisted standard Session after its live Agent has closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-standard-transfer-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      await ctx.plugin(AgentLoop, { agents: [] })
      const adapter = new MockAdapter([textResponse('stored answer'), textResponse('continued answer')])
      vi.spyOn(adapter, 'listModels').mockResolvedValue([{ provider: 'mock', id: 'model', name: 'model' }])
      ctx.llm.registerAdapter(['mock'], adapter)
      const sourceId = SessionId('stored-standard-source')
      const source = await ctx.agents.create({
        sessionId: sourceId, agentOptions: { provider: 'mock', model: 'model' },
      })
      const oldIdle = waitForIdle(ctx, source.agent)
      source.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'before close' }] }))
      await oldIdle
      const ports = ctx.agents.getTransferPorts('standard')
      const flush = vi.spyOn(ctx.sessions, 'flush')
      const liveContext = (await ports.source.exportPortableContext(sourceId)).context
      expect(flush).toHaveBeenCalledExactlyOnceWith(source.agent.session)
      await source.dispose()
      expect(ctx.sessions.get(sourceId)).toBeUndefined()
      expect((await ports.source.exportPortableContext(sourceId)).context).toEqual(liveContext)
      const targetId = SessionId('stored-standard-target')
      const reviewed = await prepareAgentTransfer(
        ports.source, ports.target, sourceId, targetId, { provider: 'mock', id: 'model' },
      )
      const imported = await createStandardImportedAgent(ctx, await reviewed.commit(true) as StandardImportPreparation)
      expect(adapter.requests).toHaveLength(1)
      expect(imported.agent.session.deriveMessages().map(message => message.content)).toEqual([
        [{ type: 'text', text: 'before close' }], [{ type: 'text', text: 'stored answer' }],
      ])
      const nextIdle = waitForIdle(ctx, imported.agent)
      imported.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'after close' }] }))
      await nextIdle
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]?.messages.map(message => message.content)).toEqual([
        [{ type: 'text', text: 'before close' }], [{ type: 'text', text: 'stored answer' }],
        [{ type: 'text', text: 'after close' }],
      ])
      await imported.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
