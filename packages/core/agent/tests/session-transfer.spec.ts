import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  prepareAgentTransfer,
  type AgentTransferSourcePort,
  type AgentTransferTargetPort,
} from '../src/session-transfer.ts'
import type { PortableAgentContextV1, PortableImportCapabilitiesV1 } from '../src/portable-session.ts'

const sourceSessionId = SessionId('source-session')
const targetSessionId = SessionId('target-session')
const context: PortableAgentContextV1 = {
  version: 1,
  source: {
    version: 1, sessionId: sourceSessionId,
    driver: { id: 'source-agent', version: '1' },
    model: { provider: 'shared', id: 'model' },
  },
  items: [{ id: 'message', role: 'user', content: [{ kind: 'text', text: 'hello' }], provenance: { kind: 'user' } }],
  effectiveItemIds: ['message'], compactions: [],
}
const targetModel = context.source.model

function source(bundle: unknown = { context }): AgentTransferSourcePort {
  return { driverId: 'source-agent', exportArchivedContext: vi.fn(), exportPortableContext: vi.fn(async () => bundle as { context: PortableAgentContextV1 }) }
}

function target(driverId: string, capabilities: Partial<PortableImportCapabilitiesV1> = {}) {
  return {
    driverId,
    describeAuthentication: async () => ({ status: 'unverified' as const }),
    importCapabilities: () => ({
      driverId, supportedContextVersions: [1], supportedPrivateSnapshotVersions: [], supportedPrivateRevisions: [],
      supportedOpaqueNamespaces: [], availableModels: [{ provider: 'shared', id: 'model' }], ...capabilities,
    }),
    importPortableContext: vi.fn(async () => 'prepared target state'),
  } satisfies AgentTransferTargetPort<string>
}

describe('portable Agent Session transfer', () => {
  it('lets an independent third agent import and then export the same model-visible context', async () => {
    const portable: PortableAgentContextV1 = {
      ...context,
      items: [
        ...context.items,
        { id: 'tool-call', role: 'assistant', content: [{ kind: 'tool-call', callId: 'call-1', name: 'lookup', arguments: '{"q":"x"}' }], provenance: { kind: 'model' } },
        { id: 'tool-result', role: 'tool', content: [{ kind: 'tool-result', callId: 'call-1', content: [{ kind: 'text', text: 'found' }], isError: false }], provenance: { kind: 'tool' } },
      ],
      effectiveItemIds: ['message', 'tool-call', 'tool-result'],
    }
    const importedSessions = new Map<string, PortableAgentContextV1>()
    type ImportInput = Parameters<AgentTransferTargetPort<PortableAgentContextV1>['importPortableContext']>[0]
    const importThird = vi.fn(async ({ context: exported, targetSessionId: id, lineage }: ImportInput) => {
      const restored: PortableAgentContextV1 = structuredClone({
        ...exported,
        source: { ...exported.source, sessionId: id, driver: { id: 'third-agent', version: '1' }, lineage },
      })
      importedSessions.set(id, restored)
      return restored
    })
    const exportThird = vi.fn(async (id: SessionId) => {
      const restored = importedSessions.get(id)
      if (restored === undefined) throw new Error('third agent has no imported Session')
      return { context: structuredClone(restored) }
    })
    const third: AgentTransferSourcePort & AgentTransferTargetPort<PortableAgentContextV1> = {
      driverId: 'third-agent',
      describeAuthentication: async () => ({ status: 'unverified' as const }),
      importCapabilities: () => ({
        driverId: 'third-agent', supportedContextVersions: [1], supportedPrivateSnapshotVersions: [],
        supportedPrivateRevisions: [], supportedOpaqueNamespaces: [],
        availableModels: [{ provider: 'shared', id: 'model' }],
      }),
      importPortableContext: importThird,
      exportArchivedContext: vi.fn(), exportPortableContext: exportThird,
    }
    const intoThird = await prepareAgentTransfer(source({ context: portable }), third, sourceSessionId, targetSessionId, targetModel)
    const restored = await intoThird.commit(true)
    expect(restored.items).toEqual(portable.items)
    expect(restored.effectiveItemIds).toEqual(portable.effectiveItemIds)
    expect(restored.source).toMatchObject({ sessionId: targetSessionId, driver: { id: 'third-agent' }, lineage: intoThird.lineage })

    const final = target('source-agent')
    const returnSessionId = SessionId('return-session')
    const back = await prepareAgentTransfer(third, final, targetSessionId, returnSessionId, targetModel)
    await back.commit(true)
    expect(final.importPortableContext).toHaveBeenCalledWith({
      context: restored, targetSessionId: returnSessionId, targetModel, lineage: back.lineage,
    })
    expect(importThird).toHaveBeenCalledTimes(1)
    expect(exportThird).toHaveBeenCalledTimes(1)
  })

  it('routes the same canonical context to a third driver without a pair adapter', async () => {
    const exporter = source()
    const destination = target('third-agent')
    const prepared = await prepareAgentTransfer(exporter, destination, sourceSessionId, targetSessionId, targetModel)
    expect(prepared.assessment.fidelity).toBe('portable')
    expect(prepared.lineage.sourceSessionId).toBe(sourceSessionId)
    expect(prepared.lineage.sourceDriverId).toBe('source-agent')
    expect(destination.importPortableContext).not.toHaveBeenCalled()
    expect(() => prepared.commit(false)).toThrow('warnings require acknowledgment')
    const first = prepared.commit(true)
    expect(prepared.commit(true)).toBe(first)
    await expect(first).resolves.toBe('prepared target state')
    expect(destination.importPortableContext).toHaveBeenCalledTimes(1)
    expect(destination.importPortableContext).toHaveBeenCalledWith({ context, targetSessionId, targetModel, lineage: prepared.lineage })
    expect(prepared.lineage.importId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(context.source.lineage).toBeUndefined()
  })

  it('passes a matching private checkpoint only to its owning driver', async () => {
    const checkpoint = { version: 1 as const, driverId: 'source-agent', driverRevision: 'fork-1', schemaVersion: 1, context: [] }
    const exporter = source({ context, privateSnapshot: checkpoint })
    const own = target('source-agent', { supportedPrivateSnapshotVersions: [1], supportedPrivateRevisions: ['fork-1'] })
    const prepared = await prepareAgentTransfer(exporter, own, sourceSessionId, targetSessionId, targetModel)
    expect(prepared.assessment.fidelity).toBe('same-driver')
    await prepared.commit(false)
    expect(own.importPortableContext).toHaveBeenCalledWith({
      context, privateSnapshot: checkpoint, targetSessionId, targetModel, lineage: prepared.lineage,
    })

    const other = target('other-agent')
    const cross = await prepareAgentTransfer(exporter, other, sourceSessionId, targetSessionId, targetModel)
    await cross.commit(true)
    expect(other.importPortableContext).toHaveBeenCalledWith({ context, targetSessionId, targetModel, lineage: cross.lineage })
  })

  it('requires acknowledgment for a selected model change and withholds the old private checkpoint', async () => {
    const checkpoint = { version: 1 as const, driverId: 'source-agent', driverRevision: 'fork-1', schemaVersion: 1, context: [] }
    const destination = target('source-agent', {
      supportedPrivateSnapshotVersions: [1], supportedPrivateRevisions: ['fork-1'],
      availableModels: [{ provider: 'new-provider', id: 'new-model' }],
    })
    const chosen = { provider: 'new-provider', id: 'new-model' }
    const prepared = await prepareAgentTransfer(
      source({ context, privateSnapshot: checkpoint }), destination, sourceSessionId, targetSessionId, chosen,
    )
    chosen.id = 'mutated-after-preview'
    expect(prepared.assessment.fidelity).toBe('portable')
    expect(prepared.assessment.issues.map(issue => issue.code)).toEqual(['model-changed', 'private-snapshot'])
    expect(() => prepared.commit(false)).toThrow('warnings require acknowledgment')
    await prepared.commit(true)
    expect(destination.importPortableContext).toHaveBeenCalledWith({
      context, targetSessionId, targetModel: { provider: 'new-provider', id: 'new-model' }, lineage: prepared.lineage,
    })
  })

  it('blocks an unavailable selected target model before invoking its import port', async () => {
    const destination = target('source-agent')
    const prepared = await prepareAgentTransfer(
      source(), destination, sourceSessionId, targetSessionId, { provider: 'missing', id: 'model' },
    )
    expect(prepared.assessment.fidelity).toBe('unsupported')
    expect(prepared.assessment.issues.map(issue => [issue.severity, issue.code]))
      .toEqual([['warning', 'model-changed'], ['error', 'model-unavailable']])
    expect(() => prepared.commit(true)).toThrow('blocking compatibility errors')
    expect(destination.importPortableContext).not.toHaveBeenCalled()
  })

  it('rejects a model removed from the target catalog after preview', async () => {
    let availableModels = [targetModel]
    const destination = {
      ...target('source-agent'),
      describeAuthentication: async () => ({ status: 'unverified' as const }),
      importCapabilities: () => ({
        driverId: 'source-agent', supportedContextVersions: [1], supportedPrivateSnapshotVersions: [],
        supportedPrivateRevisions: [], supportedOpaqueNamespaces: [], availableModels,
      }),
    }
    const prepared = await prepareAgentTransfer(source(), destination, sourceSessionId, targetSessionId, targetModel)
    availableModels = []
    await expect(prepared.commit(false)).rejects.toThrow('unavailable at import commit')
    expect(destination.importPortableContext).not.toHaveBeenCalled()
  })

  it('rejects invalid source identity and blocking compatibility before target invocation', async () => {
    await expect(prepareAgentTransfer(source(), target('source-agent'), sourceSessionId, sourceSessionId, targetModel))
      .rejects.toThrow('requires a new Session id')
    await expect(prepareAgentTransfer(source({ context: { ...context, source: { ...context.source, sessionId: 'other' } } }), target('source-agent'), sourceSessionId, targetSessionId, targetModel))
      .rejects.toThrow('identity do not match')
    const destination = target('other-agent', { supportedContextVersions: [] })
    const prepared = await prepareAgentTransfer(source(), destination, sourceSessionId, targetSessionId, targetModel)
    expect(prepared.assessment.fidelity).toBe('unsupported')
    expect(() => prepared.commit(true)).toThrow('blocking compatibility errors')
    expect(destination.importPortableContext).not.toHaveBeenCalled()
  })

  it('does not retry a destination port after an uncertain failure', async () => {
    const destination = {
      ...target('other-agent'),
      importPortableContext: vi.fn(async () => { throw new Error('destination outcome unknown') }),
    }
    const prepared = await prepareAgentTransfer(source(), destination, sourceSessionId, targetSessionId, targetModel)
    const first = prepared.commit(true)
    expect(prepared.commit(true)).toBe(first)
    await expect(first).rejects.toThrow('destination outcome unknown')
    expect(destination.importPortableContext).toHaveBeenCalledTimes(1)
  })

  it('does not prepare a new Session from a source with an active turn', async () => {
    const exporter: AgentTransferSourcePort = {
      driverId: 'source-agent',
      exportArchivedContext: vi.fn(), exportPortableContext: vi.fn(async () => { throw new Error('source turn is active') }),
    }
    const destination = target('other-agent')
    await expect(prepareAgentTransfer(exporter, destination, sourceSessionId, targetSessionId, targetModel))
      .rejects.toThrow('source turn is active')
    expect(destination.importPortableContext).not.toHaveBeenCalled()
  })
})
