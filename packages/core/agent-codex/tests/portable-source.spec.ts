import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { verifyArchivedAgentContext } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseCodexAuditEventV1, type CodexAuditEventV1, type CodexAuditPayloadV1 } from '../src/audit-contract.ts'
import { codexCheckpointTempPrefix, streamVerifiedCodexCheckpointArtifactV2,
  withVerifiedCodexCheckpointArtifactV2 } from '../src/checkpoint-stream.ts'
import { codexJsonSha256, type CodexContextSnapshotV2 } from '../src/context-snapshot.ts'
import { codexPortablePayloadResolver } from '../src/portable-artifact.ts'
import { projectCodexEffectiveHistory, projectCodexEffectiveHistoryStream } from '../src/portable-item.ts'
import { codexTransferSource, readCodexPortableBundle, readCodexPortablePrivateSnapshotStream,
  readCodexPortableStreamBundle } from '../src/portable-source.ts'
import { selectCodexPortableSourceFacts } from '../src/portable-source-facts.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2
const checkpoint: CodexContextSnapshotV2 = {
  ...fixture, compactions: [], rollout: [], rolloutSha256: codexJsonSha256([]),
}
const data = Buffer.from(JSON.stringify(checkpoint))
const sha256 = createHash('sha256').update(data).digest('hex')

function session(config = true, snapshot = checkpoint, compactionFacts: readonly CodexAuditEventV1[] = [],
  configuration?: CodexAuditPayloadV1): Session {
  const snapshotData = Buffer.from(JSON.stringify(snapshot))
  const snapshotSha = createHash('sha256').update(snapshotData).digest('hex')
  const result = Session.create(SessionId('codex-portable-source'))
  result.append('agent/driver-selected', { version: 1, driverId: 'codex' })
  result.append('codex/thread-bound', { version: 1, threadId: 'thread-1' as never,
    runtimeVersion: 'protocol:1;fork:fork-abc', cwd: '/workspace' })
  result.append('turn/start', { turn: 1 })
  result.append('codex/turn-bound', { version: 1, turn: 1, codexTurnId: 'turn-1' as never })
  result.append('codex/model-audit', { version: 1, turn: 1, attemptId: 'attempt-1', purpose: 'inference',
    phase: 'upstream-request', payload: { route: { provider: 'llm_proxy', model: 'glm-5', apiFormat: 'chat-completions' } } })
  result.append('codex/artifact-v1', { version: 1, threadId: 'thread-1', sha256: snapshotSha,
    bytes: snapshotData.byteLength, mediaType: 'application/json', name: `dsh-audit-${snapshotSha}.blob` })
  if (config) result.append('codex/audit-v1', parseCodexAuditEventV1({ version: 1, sequence: 1,
    eventId: 'config-1', time: 1, threadId: 'thread-1', turn: 1,
    kind: 'context/config', config: configuration ?? { kind: 'inline', value: snapshot.contextConfig } }))
  for (const fact of compactionFacts) result.append('codex/audit-v1', fact)
  const sequence = compactionFacts.length + (config ? 2 : 1)
  result.append('codex/audit-v1', parseCodexAuditEventV1({ version: 1, sequence,
    eventId: 'checkpoint-1', time: sequence, threadId: 'thread-1', turn: 1, codexTurnId: 'turn-1',
    kind: 'checkpoint', checkpointId: 'turn:turn-1',
    snapshot: { kind: 'artifact', sha256: snapshotSha, bytes: snapshotData.byteLength, mediaType: 'application/json' },
    effectiveHistorySha256: snapshot.effectiveHistorySha256 }))
  result.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return result
}

function attachments(bytes: Buffer, onRead?: () => void): AttachmentStore {
  return { async *readFileStream() { onRead?.(); yield bytes } } as unknown as AttachmentStore
}

function compactionChain(): CodexAuditEventV1[] {
  const inline = (value: unknown) => ({ kind: 'inline', value })
  const facts: CodexAuditEventV1[] = []
  let sequence = 1
  for (const [index, compaction] of fixture.compactions.entries()) {
    const base = { version: 1, threadId: 'thread-1', turn: 1, compactionId: compaction.id }
    const append = (value: Record<string, unknown>) => {
      sequence++
      facts.push(parseCodexAuditEventV1({ ...base, sequence, eventId: `compaction-${sequence}`,
        time: sequence, ...value }))
    }
    append({ kind: 'compaction/request', reason: 'threshold', inputHistory: inline([]),
      prompt: inline({ compactionMetadata: { implementation: index === 0 ? 'responses' : 'responses_compaction_v2' } }) })
    append({ kind: 'compaction/result', result: inline({ outputItems: [] }) })
    append({ kind: 'compaction/pending', effectiveHistory: inline(compaction.replacementHistory) })
    append({ kind: 'compaction/installed', effectiveHistory: inline(compaction.replacementHistory) })
  }
  return facts
}

async function expectStreamMatchesResident(source: Session, bytes: Buffer, store = attachments(bytes)): Promise<void> {
  const resident = await readCodexPortableBundle(source, store)
  const streamed = await readCodexPortableStreamBundle(source, store)
  const items = []
  for await (const item of streamed.context.items) {
    if ('encoding' in item) {
      const chunks = []
      for await (const chunk of item.json.chunks) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      expect(bytes.length).toBe(item.json.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(item.json.sha256)
      items.push({ id: item.id, role: item.role,
        content: [{ kind: 'opaque', namespace: item.namespace, value: JSON.parse(bytes.toString()) as unknown }],
        provenance: item.provenance })
    } else items.push(item)
  }
  const effectiveItemIds = []
  for await (const id of streamed.context.effectiveItemIds) effectiveItemIds.push(id)
  const compactions = []
  for await (const compaction of streamed.context.compactions) compactions.push(compaction)
  const context = { version: streamed.context.version, source: streamed.context.source,
    items, effectiveItemIds, compactions }
  expect(Buffer.from(JSON.stringify(context))).toEqual(Buffer.from(JSON.stringify(resident.context)))
  const privateBytes: Uint8Array[] = []
  if (streamed.privateSnapshot !== undefined && 'contextJson' in streamed.privateSnapshot) {
    for await (const chunk of streamed.privateSnapshot.contextJson) privateBytes.push(chunk)
  }
  expect(Buffer.concat(privateBytes)).toEqual(bytes)
}

describe('Codex portable source read', () => {
  it('adapts both transfer reads and refuses a missing or mismatched Session id', async () => {
    const source = session()
    const port = codexTransferSource(id => id === source.id ? source : undefined, attachments(data))
    expect(port.driverId).toBe('codex')
    expect((await port.exportPortableContext(source.id)).context.items.map(item => item.id))
      .toEqual(['codex:response:0'])
    if (port.exportPortableContextStream === undefined) throw new Error('missing Codex stream port')
    const streamed = await port.exportPortableContextStream(source.id)
    const items = []
    for await (const item of streamed.context.items) items.push(item.id)
    expect(items).toEqual(['codex:response:0'])
    await expect(port.exportPortableContext(SessionId('other'))).rejects.toThrow('unavailable')
    await expect(port.exportPortableContextStream(SessionId('other'))).rejects.toThrow('unavailable')
    await expect(codexTransferSource(() => source, attachments(data))
      .exportPortableContext(SessionId('other'))).rejects.toThrow('unavailable')
  })

  it('reprojects an archive using only its detached Session and supplied artifacts', async () => {
    const archived = session()
    const expected = await readCodexPortableBundle(archived, attachments(data))
    const live = vi.fn(() => { throw new Error('live Session must not be read') })
    const localRead = vi.fn(() => { throw new Error('local attachment store must not be read') })
    const source = codexTransferSource(live, { readFileStream: localRead })
    const readArtifact = vi.fn(async function* (requestedSha: string, bytes: number) {
      expect(requestedSha).toBe(sha256)
      expect(bytes).toBe(data.length)
      yield data
    })
    await verifyArchivedAgentContext(source, { session: archived, readArtifact }, expected)
    expect(live).not.toHaveBeenCalled()
    expect(localRead).not.toHaveBeenCalled()
    expect(readArtifact).toHaveBeenCalled()
    const privateSnapshot = expected.privateSnapshot
    if (privateSnapshot === undefined) throw new Error('missing source checkpoint')
    await expect(verifyArchivedAgentContext(source, { session: archived, readArtifact }, {
      ...expected, privateSnapshot: { ...privateSnapshot, context: null },
    })).rejects.toThrow('differs from source projection')
    await expect(verifyArchivedAgentContext(source, { session: archived,
      readArtifact: async function* () { yield Buffer.from('changed') },
    }, expected)).rejects.toThrow(/hash|size/)
  })

  it('exports byte-identical canonical context and private V2 bytes with and without compaction', async () => {
    await expectStreamMatchesResident(session(), data)
    const full = Buffer.from(JSON.stringify(fixture))
    await expectStreamMatchesResident(session(true, fixture, compactionChain()), full)
  })

  it('preserves the exported context when installed histories live in verified artifacts', async () => {
    const full = Buffer.from(JSON.stringify(fixture))
    const blobs = new Map<string, Buffer>([[createHash('sha256').update(full).digest('hex'), full]])
    const artifact = (payload: CodexAuditPayloadV1) => {
      if (payload.kind !== 'inline') throw new Error('expected inline fixture')
      const bytes = Buffer.from(JSON.stringify(payload.value))
      const digest = createHash('sha256').update(bytes).digest('hex')
      blobs.set(digest, bytes)
      return { kind: 'artifact' as const, sha256: digest, bytes: bytes.byteLength, mediaType: 'application/json' }
    }
    const chain = compactionChain().map((fact) => {
      if (fact.kind === 'compaction/request') return { ...fact, inputHistory: artifact(fact.inputHistory), prompt: artifact(fact.prompt) }
      if (fact.kind === 'compaction/result') return { ...fact, result: artifact(fact.result) }
      if (fact.kind === 'compaction/pending' || fact.kind === 'compaction/installed') {
        return { ...fact, effectiveHistory: artifact(fact.effectiveHistory) }
      }
      return fact
    })
    const source = session(true, fixture, chain, artifact({ kind: 'inline', value: fixture.contextConfig }))
    for (const [digest, bytes] of blobs) {
      if (bytes === full) continue
      source.append('codex/artifact-v1', { version: 1, threadId: 'thread-1', sha256: digest,
        bytes: bytes.byteLength, mediaType: 'application/json', name: `dsh-audit-${digest}.blob` })
    }
    const store = { async *readFileStream(ref: FileAttachmentRef) {
      const bytes = blobs.get(ref.attachmentId.slice('sha256:'.length))
      if (bytes === undefined) throw new Error('missing test blob')
      for (let offset = 0; offset < bytes.length; offset += 13) yield bytes.subarray(offset, offset + 13)
    } } as unknown as AttachmentStore
    await expectStreamMatchesResident(source, full, store)
    const facts = selectCodexPortableSourceFacts(source)
    const resolver = codexPortablePayloadResolver(source, 'thread-1', store)
    const noResidentHistory = Object.assign(async (payload: CodexAuditPayloadV1) => {
      if (payload.kind === 'artifact') throw new Error('history must not use resident JSON resolution')
      return payload.value
    }, { historySha256: (payload: CodexAuditPayloadV1) => resolver.historySha256(payload),
      configurationMatches: (payload: CodexAuditPayloadV1, expected: JsonValue) => resolver.configurationMatches(payload, expected) })
    await withVerifiedCodexCheckpointArtifactV2((async function* () { yield full })(),
      facts.checkpoint.snapshot, facts.checkpoint, facts.preceding, noResidentHistory,
      (read) => { expect(read.runtimeRevision).toBe(fixture.runtimeRevision) })
  })

  it('rejects a Session append or checkpoint mutation after stream preflight', async () => {
    const source = session()
    const bundle = await readCodexPortableStreamBundle(source, attachments(data))
    await expect((async () => { for await (const id of bundle.context.effectiveItemIds) void id })())
      .rejects.toThrow('not fully consumed')
    source.append('turn/start', { turn: 2 })
    await expect((async () => { for await (const item of bundle.context.items) void item })())
      .rejects.toThrow('Session changed before streaming')

    let reads = 0
    const altered = Buffer.from(data)
    altered[10] = (altered[10] ?? 0) ^ 1
    const store = { async *readFileStream() { yield reads++ === 0 ? data : altered } } as unknown as AttachmentStore
    const changed = await readCodexPortableStreamBundle(session(), store)
    await expect((async () => { for await (const item of changed.context.items) void item })())
      .rejects.toThrow('hash or size differs')

    const during = session()
    let count = 0
    const duringStream = await readCodexPortableStreamBundle(during, attachments(data, () => {
      if (++count === 2) during.append('turn/start', { turn: 2 })
    }))
    await expect((async () => { for await (const item of duringStream.context.items) void item })())
      .rejects.toThrow('Session changed during streaming')

    const privateSession = session()
    let privateReads = 0
    const privateBundle = await readCodexPortableStreamBundle(privateSession, attachments(data, () => {
      if (++privateReads === 3) privateSession.append('turn/start', { turn: 2 })
    }))
    for await (const item of privateBundle.context.items) void item
    const privateSnapshot = privateBundle.privateSnapshot
    if (privateSnapshot === undefined || !('contextJson' in privateSnapshot)) {
      throw new Error('missing streamed private checkpoint')
    }
    await expect((async () => { for await (const chunk of privateSnapshot.contextJson) void chunk })())
      .rejects.toThrow('Session changed during private bytes')
  })

  it('keeps a verified spool only while its projected iterator is consumed', async () => {
    const source = session()
    const facts = selectCodexPortableSourceFacts(source)
    const resolve = codexPortablePayloadResolver(source, facts.binding.threadId, attachments(data))
    const chunks = async function* () { yield data }
    const prefix = codexCheckpointTempPrefix()
    const directories = async () => (await readdir(tmpdir())).filter(name => name.startsWith(prefix)).sort()
    const before = await directories()
    const stream = () => streamVerifiedCodexCheckpointArtifactV2(chunks(), { sha256, bytes: data.byteLength },
      facts.checkpoint, facts.preceding, resolve, read => read.array('effectiveHistory'))
    const partial = stream()
    expect(await directories()).toEqual(before)
    expect((await partial.next()).value).toEqual(checkpoint.effectiveHistory[0])
    expect((await directories()).length).toBe(before.length + 1)
    await partial.return(undefined)
    expect(await directories()).toEqual(before)

    const history = []
    for await (const value of stream()) history.push(value)
    expect(history).toEqual(checkpoint.effectiveHistory)
    expect(await directories()).toEqual(before)

    const failed = streamVerifiedCodexCheckpointArtifactV2(chunks(), { sha256, bytes: data.byteLength },
      facts.checkpoint, facts.preceding, resolve, async function* (read) {
        yield* read.array('effectiveHistory')
        throw new Error('projection failed')
      })
    await expect((async () => { for await (const value of failed) void value })())
      .rejects.toThrow('projection failed')
    expect(await directories()).toEqual(before)
  })

  it('reads validated V2 arrays from the scoped spool and removes it after callback failure', async () => {
    const source = session()
    const facts = selectCodexPortableSourceFacts(source)
    const resolve = codexPortablePayloadResolver(source, facts.binding.threadId, attachments(data))
    const chunks = async function* () { yield data.subarray(0, 17); yield data.subarray(17) }
    const inspect = () => withVerifiedCodexCheckpointArtifactV2(chunks(), { sha256, bytes: data.byteLength },
      facts.checkpoint, facts.preceding, resolve, async (read) => {
        const history = []
        for await (const item of read.array('effectiveHistory')) history.push(item)
        const projected = []
        for await (const item of projectCodexEffectiveHistoryStream(read.array('effectiveHistory'), new Map())) {
          projected.push(item)
        }
        const rollout = []
        for await (const item of read.array('rollout')) rollout.push(item)
        return { runtimeRevision: read.runtimeRevision,
          retainedContext: await read.field('retainedContext'), history, projected, rollout }
      })
    expect(await inspect()).toEqual({ runtimeRevision: checkpoint.runtimeRevision,
      retainedContext: checkpoint.retainedContext, history: checkpoint.effectiveHistory,
      projected: projectCodexEffectiveHistory(checkpoint, new Map()), rollout: [] })
    const prefix = codexCheckpointTempPrefix()
    const before = (await readdir(tmpdir())).filter(name => name.startsWith(prefix)).sort()
    await expect(withVerifiedCodexCheckpointArtifactV2(chunks(), { sha256, bytes: data.byteLength },
      facts.checkpoint, facts.preceding, resolve, async (read) => {
        for await (const item of read.array('effectiveHistory')) { void item; break }
        throw new Error('callback failed')
      })).rejects.toThrow('callback failed')
    expect((await readdir(tmpdir())).filter(name => name.startsWith(prefix)).sort()).toEqual(before)
  })

  it('validates checkpoint V2 before offering a second digest-checked private JSON stream', async () => {
    let reads = 0
    const snapshot = await readCodexPortablePrivateSnapshotStream(session(), attachments(data, () => { reads++ }))
    expect(reads).toBe(1)
    expect(snapshot).toMatchObject({ version: 1, driverId: 'codex', schemaVersion: 2,
      driverRevision: checkpoint.runtimeRevision, contextBytes: data.byteLength, contextSha256: sha256 })
    const chunks: Uint8Array[] = []
    for await (const chunk of snapshot.contextJson) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(data)
    expect(reads).toBe(2)
  })

  it('rejects damaged or unaudited checkpoints and a changing Session before streaming', async () => {
    await expect(readCodexPortablePrivateSnapshotStream(session(), attachments(Buffer.from('tampered'))))
      .rejects.toThrow('hash or size differs')
    await expect(readCodexPortablePrivateSnapshotStream(session(false), attachments(data)))
      .rejects.toThrow('no matching accepted turn configuration')
    const source = session()
    await expect(readCodexPortablePrivateSnapshotStream(source, attachments(data, () => {
      source.append('turn/start', { turn: 2 })
    }))).rejects.toThrow('Session changed during read')
  })

  it('rejects an artifact changed between preflight and private-stream consumption', async () => {
    let reads = 0
    const altered = Buffer.from(data)
    altered[10] = (altered[10] ?? 0) ^ 1
    const store = { async *readFileStream() { yield reads++ === 0 ? data : altered } } as unknown as AttachmentStore
    const snapshot = await readCodexPortablePrivateSnapshotStream(session(), store)
    await expect((async () => {
      for await (const chunk of snapshot.contextJson) void chunk
    })()).rejects.toThrow('hash or size differs')
  })

  it('returns one verified canonical bundle with source model and exact private checkpoint', async () => {
    const bundle = await readCodexPortableBundle(session(), attachments(data))
    expect(bundle.context.source).toEqual({ version: 1, sessionId: 'codex-portable-source',
      driver: { id: 'codex', version: 'protocol:1;fork:fork-abc' },
      model: { provider: 'codex:llm_proxy', id: 'llm_proxy/glm-5' } })
    expect(bundle.context.items.map(item => item.id)).toEqual(['codex:response:0'])
    expect(bundle.context.effectiveItemIds).toEqual(['codex:response:0'])
    expect(bundle.context.compactions).toEqual([])
    expect(bundle.privateSnapshot?.context).toEqual(checkpoint)
  })

  it('rejects changed artifact, absent config, and active turn before exposing a bundle', async () => {
    await expect(readCodexPortableBundle(session(), attachments(Buffer.from('tampered'))))
      .rejects.toThrow('hash or size differs')
    await expect(readCodexPortableBundle(session(false), attachments(data)))
      .rejects.toThrow('no matching accepted turn configuration')
    const active = session()
    active.append('turn/start', { turn: 2 })
    let reads = 0
    await expect(readCodexPortableBundle(active, attachments(data, () => { reads++ })))
      .rejects.toThrow('no completed turn boundary')
    expect(reads).toBe(0)
  })

  it('rejects a concurrent Session append while resolving the checkpoint', async () => {
    const source = session()
    await expect(readCodexPortableBundle(source, attachments(data, () => {
      source.append('turn/start', { turn: 2 })
    }))).rejects.toThrow('Session changed during read')
  })
})
