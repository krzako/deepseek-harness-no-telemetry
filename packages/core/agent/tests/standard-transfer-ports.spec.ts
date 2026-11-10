import { portableAttachmentKey } from '../src/portable-session.ts'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { prepareAgentTransfer, verifyArchivedAgentContext, type AgentTransferSourcePort } from '../src/session-transfer.ts'
import { buildStandardImportSeed } from '../src/standard-import-seed.ts'
import { projectStandardSession } from '../src/standard-session-export.ts'
import { standardTransferSource, standardTransferTarget } from '../src/standard-transfer-ports.ts'

const sourceId = SessionId('source-standard')
const targetId = SessionId('target-standard')
const model = { provider: 'mock', id: 'model-1' }

function completedSession(): Session {
  const session = Session.create(sourceId)
  session.append('request/header', { reason: 'initial', header: { config: { provider: model.provider, model: model.id } } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }],
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('standard driver portable transfer ports', () => {
  it('offers a single-use ZIP stream beside the resident import-preview context', async () => {
    const session = completedSession()
    const port = standardTransferSource(() => session)
    const bundle = await port.exportPortableContextStream?.(sourceId)
    expect(bundle).toBeDefined()
    expect(bundle?.context.source).not.toHaveProperty('lineage')
    const items = []
    for await (const item of bundle?.context.items ?? []) items.push(item)
    expect(items).toEqual(projectStandardSession(session).items)
    expect((await port.exportPortableContext(sourceId)).context).toEqual(projectStandardSession(session))
  })

  it('prepares a new standard Session without mutating or replaying the source', async () => {
    const session = completedSession()
    const before = session.snapshotEvents()
    const resolve = vi.fn(async (id: SessionId) => id === sourceId ? session : undefined)
    const catalog = vi.fn(() => [model])
    const prepared = await prepareAgentTransfer(
      standardTransferSource(resolve), standardTransferTarget(catalog), sourceId, targetId, model,
    )
    expect(prepared.assessment).toEqual({ fidelity: 'portable', issues: [] })
    const imported = await prepared.commit(false)
    expect(imported.targetSessionId).toBe(targetId)
    expect(imported.targetModel).toEqual(model)
    expect(imported.lineage).toEqual(prepared.lineage)
    expect(imported.context).toEqual(projectStandardSession(session))
    expect(imported.projection.entries).toMatchObject([{
      kind: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }])
    expect(session.snapshotEvents()).toEqual(before)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(sourceId)
    expect(catalog).toHaveBeenCalledTimes(3)
  })

  it('retains persisted ancestry when an imported Session is exported again', async () => {
    const session = completedSession()
    const prepared = await prepareAgentTransfer(
      standardTransferSource(() => session), standardTransferTarget(() => [model]), sourceId, targetId, model,
    )
    const imported = await prepared.commit(false)
    const seed = buildStandardImportSeed(imported)
    const lineage = { ...imported.lineage, sourceSessionId: sourceId }
    const restored = Session.create(targetId, seed.events, { ...session.header, id: targetId, importLineage: lineage })
    const before = restored.snapshotEvents()
    const port = standardTransferSource(() => restored)
    const resident = await port.exportPortableContext(targetId)
    const streamed = await port.exportPortableContextStream?.(targetId)
    expect(resident.context.source.lineage).toEqual(lineage)
    expect(streamed?.context.source).toEqual(resident.context.source)
    expect(resident.context.source.sessionId).toBe(targetId)
    expect(restored.snapshotEvents()).toEqual(before)
    const next = await prepareAgentTransfer(port, standardTransferTarget(() => [model]),
      targetId, SessionId('third-standard'), model)
    expect(next.lineage.sourceSessionId).toBe(targetId)
    expect(next.lineage.importId).not.toBe(lineage.importId)
    expect((await next.commit(false)).context.source.lineage).toEqual(lineage)
  })

  it('projects archived facts without calling a live resolver or artifact reader', async () => {
    const session = completedSession()
    const live = vi.fn(() => { throw new Error('live source must not be read') })
    const readArtifact = vi.fn(() => { throw new Error('standard projection needs no artifacts') })
    const port = standardTransferSource(live)
    const expected = { context: projectStandardSession(session) }
    await verifyArchivedAgentContext(port, { session, readArtifact }, expected)
    expect(live).not.toHaveBeenCalled()
    expect(readArtifact).not.toHaveBeenCalled()
    await expect(verifyArchivedAgentContext(port, { session, readArtifact }, {
      context: { ...expected.context, effectiveItemIds: [] },
    })).rejects.toThrow('differs from source projection')
    await expect(verifyArchivedAgentContext({ ...port, driverId: 'other' }, { session, readArtifact }, expected))
      .rejects.toThrow('source identity')
    await expect(verifyArchivedAgentContext({ ...port, exportArchivedContext: async ({ session: archived }) => {
      archived.append('turn/start', { turn: 2 })
      return expected
    } }, { session, readArtifact }, expected)).rejects.toThrow('modified its Session')
  })

  it('refuses an active source turn before target preparation', async () => {
    const session = completedSession()
    session.append('turn/start', { turn: 2 })
    const catalog = vi.fn(() => [model])
    await expect(prepareAgentTransfer(
      standardTransferSource(() => session), standardTransferTarget(catalog), sourceId, targetId, model,
    )).rejects.toThrow('active')
    expect(catalog).not.toHaveBeenCalled()
  })

  it('accepts another source driver through the same target port after warning acknowledgment', async () => {
    const context = projectStandardSession(completedSession())
    const codexSource: AgentTransferSourcePort = {
      driverId: 'codex',
      exportArchivedContext: vi.fn(), exportPortableContext: async () => ({
        context: { ...context, source: { ...context.source, driver: { id: 'codex', version: '1' } } },
      }),
    }
    const prepared = await prepareAgentTransfer(
      codexSource, standardTransferTarget(() => [model]), sourceId, targetId, model,
    )
    expect(prepared.assessment.issues.map(issue => issue.code)).toEqual(['driver-changed'])
    expect(() => prepared.commit(false)).toThrow('warnings require acknowledgment')
    const imported = await prepared.commit(true)
    expect(imported.context.source.driver.id).toBe('codex')
    expect(imported.projection.entries).toHaveLength(1)
  })

  it('rejects an unavailable model and forged lineage at the target port itself', async () => {
    const context = projectStandardSession(completedSession())
    const port = standardTransferTarget(() => [model])
    const input = {
      context, targetSessionId: targetId, targetModel: model,
      lineage: { sourceSessionId: sourceId, sourceDriverId: 'standard', importId: 'import-1' },
    }
    await expect(port.importPortableContext({
      ...input, targetModel: { provider: 'missing', id: 'model' },
    })).rejects.toThrow('unavailable')
    await expect(port.importPortableContext({
      ...input, lineage: { ...input.lineage, sourceDriverId: 'codex' },
    })).rejects.toThrow('lineage does not match')
  })

  it('reads an asynchronous model catalog again before import commit', async () => {
    let available = [model]
    const catalog = vi.fn(async () => available)
    const prepared = await prepareAgentTransfer(
      standardTransferSource(() => completedSession()),
      standardTransferTarget(catalog), sourceId, targetId, model,
    )
    expect(prepared.assessment.issues).toEqual([])
    available = []
    await expect(prepared.commit(false)).rejects.toThrow('unavailable at import commit')
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('passes a transfer-local resolved attachment without retaining mutable caller input', async () => {
    const base = projectStandardSession(completedSession())
    const context = { ...base, items: base.items.map(item => item.role === 'user'
      ? { ...item, content: [{ kind: 'attachment' as const, attachmentId: 'image-1', mediaType: 'image/png', name: 'a.png' }] }
      : item) }
    const image = { type: 'image', attachment: {
      attachmentId: 'image-1' as never, mediaType: 'image/png', name: 'a.png', bytes: 4, width: 1, height: 1,
    } } satisfies Extract<ContentBlock, { type: 'image' }>
    const attachments = new Map<string, typeof image>([[portableAttachmentKey(image.attachment), image]])
    const prepared = await prepareAgentTransfer(
      { driverId: 'standard', exportArchivedContext: vi.fn(), exportPortableContext: async () => ({ context }) },
      standardTransferTarget(() => [model]), sourceId, targetId, model, attachments,
    )
    attachments.set(portableAttachmentKey(image.attachment), { ...image, attachment: { ...image.attachment, name: 'changed.png' } })
    const imported = await prepared.commit(false)
    expect(imported.projection.entries).toMatchObject([{
      kind: 'message', message: { content: [image] },
    }])
  })
})
