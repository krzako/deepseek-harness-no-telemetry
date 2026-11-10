import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { prepareAgentTransfer, type AgentTransferSourcePort, type PortableAgentContextV1 } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { codexPrivateSnapshot, type CodexContextSnapshotV2 } from '../src/context-snapshot.ts'
import { codexTransferTarget } from '../src/portable-target.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2
const sourceId = SessionId('source-codex')
const targetId = SessionId('target-codex')
const model = { provider: 'codex:llm_proxy', id: 'llm_proxy/glm-5' }
const context: PortableAgentContextV1 = { version: 1,
  source: { version: 1, sessionId: sourceId, driver: { id: 'codex', version: 'protocol:1;fork:fork-abc' }, model },
  items: [], effectiveItemIds: [], compactions: [] }
const privateSnapshot = codexPrivateSnapshot(fixture)

describe('Codex portable target preparation', () => {
  it('prepares same-driver V2 without publishing a Session or replaying effects', async () => {
    const source: AgentTransferSourcePort = { driverId: 'codex',
      exportArchivedContext: vi.fn(), exportPortableContext: async () => ({ context, privateSnapshot }) }
    const target = codexTransferTarget(() => [model], () => fixture.runtimeRevision)
    const prepared = await prepareAgentTransfer(source, target, sourceId, targetId, model)
    expect(prepared.assessment).toEqual({ fidelity: 'same-driver', issues: [] })
    const imported = await prepared.commit(false)
    expect(imported).toMatchObject({ context, privateSnapshot, targetSessionId: targetId,
      targetModel: model, lineage: prepared.lineage })
    expect(Object.isFrozen(imported)).toBe(true)
    expect(Object.isFrozen(imported.context)).toBe(true)
  })

  it('declares current model and revision and rejects stale selections at commit', async () => {
    let available = [model]
    const source: AgentTransferSourcePort = { driverId: 'codex',
      exportArchivedContext: vi.fn(), exportPortableContext: async () => ({ context, privateSnapshot }) }
    const target = codexTransferTarget(() => available, () => fixture.runtimeRevision)
    expect(await target.importCapabilities()).toMatchObject({ availableModels: [model],
      supportedContextVersions: [1], supportedPrivateSnapshotVersions: [2],
      supportedPrivateRevisions: [fixture.runtimeRevision] })
    const prepared = await prepareAgentTransfer(source, target, sourceId, targetId, model)
    available = []
    await expect(prepared.commit(false)).rejects.toThrow('unavailable')
  })

  it('rejects reused IDs, forged lineage, missing model, and incompatible private V2', async () => {
    const target = codexTransferTarget(() => [model], () => fixture.runtimeRevision)
    const input = { context, targetSessionId: targetId, targetModel: model,
      lineage: { sourceSessionId: sourceId, sourceDriverId: 'codex', importId: 'import-1' }, privateSnapshot }
    await expect(target.importPortableContext({ ...input, targetSessionId: sourceId }))
      .rejects.toThrow('new Session id')
    await expect(target.importPortableContext({ ...input,
      lineage: { ...input.lineage, sourceDriverId: 'standard' } })).rejects.toThrow('lineage')
    await expect(target.importPortableContext({ ...input,
      targetModel: { provider: 'codex:missing', id: 'missing' } })).rejects.toThrow('unavailable')
    await expect(target.importPortableContext({ ...input,
      privateSnapshot: { ...privateSnapshot, driverRevision: 'other' } })).rejects.toThrow('incompatible')
    await expect(target.importPortableContext({ ...input,
      privateSnapshot: { ...privateSnapshot, context: { version: 2 } } })).rejects.toThrow('incompatible')
  })
})
