import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CodexAuditReceiver } from '../src/audit-receiver.ts'
import { codexJsonSha256 } from '../src/context-snapshot.ts'

function fact(sequence: number, eventId = `event-${sequence}`) {
  return {
    version: 1, sequence, eventId, time: 1, threadId: 'thread-1', turn: 0,
    kind: 'context/config', config: { kind: 'inline', value: { model: 'test' } },
  } as const
}

function compaction(sequence: number, kind: 'compaction/pending' | 'compaction/installed', history: unknown = ['compacted']) {
  return {
    version: 1, sequence, eventId: `event-${sequence}`, time: 1, threadId: 'thread-1', turn: 1,
    kind, compactionId: 'compact-1', effectiveHistory: { kind: 'inline', value: history },
    ...(kind === 'compaction/pending' ? { priorRolloutSha256: 'a'.repeat(64) } : {}),
  } as const
}

function abortedCompaction(sequence: number, history: unknown = ['compacted']) {
  return { ...compaction(sequence, 'compaction/installed', history), kind: 'compaction/aborted',
    reason: 'durable rollout has no installed checkpoint' } as const
}

function artifactFact(sequence: number, sha256: string, bytes: number, mediaType = 'application/json') {
  return {
    version: 1, sequence, eventId: `artifact-fact-${sequence}`, time: 1,
    threadId: 'thread-1', turn: 1, kind: 'model/request',
    attemptId: 'attempt-1', purpose: 'inference', stage: 'model-visible', apiFormat: 'responses',
    request: { kind: 'artifact', sha256, bytes, mediaType },
  } as const
}

function attachmentReader(data: Uint8Array | Error): AttachmentStore {
  return { async *readFileStream() {
    if (data instanceof Error) throw data
    yield data
  } } as unknown as AttachmentStore
}

describe('CodexAuditReceiver', () => {
  it('verifies a multi-chunk checkpoint without assembling its full artifact in the receiver', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const history = [...fixture.effectiveHistory as unknown[],
      ...Array.from({ length: 500 }, (_, index) => ({ item: { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: `${index}:${'x'.repeat(2048)}` }] } }))]
    const rollout = [...fixture.rollout as unknown[],
      ...Array.from({ length: 500 }, (_, index) => ({ type: 'response_item', payload: {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${index}:${'y'.repeat(2048)}` }],
      } }))]
    const snapshot = { ...fixture, effectiveHistory: history, rollout,
      effectiveHistorySha256: codexJsonSha256(history as JsonValue[]), rolloutSha256: codexJsonSha256(rollout as JsonValue[]) }
    const data = Buffer.from(JSON.stringify(snapshot))
    expect(data.byteLength).toBeGreaterThan(2_000_000)
    const sha256 = createHash('sha256').update(data).digest('hex')
    let chunksRead = 0
    const attachments = { async *readFileStream() {
      for (let offset = 0; offset < data.byteLength; offset += 65536) {
        chunksRead++
        yield data.subarray(offset, offset + 65536)
      }
    } } as unknown as AttachmentStore
    const session = Session.create(SessionId('checkpoint-chunked'))
    const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn(), attachments)
    await receiver.commitArtifact({ version: 1, threadId: 'thread-1', sha256, bytes: data.length,
      mediaType: 'application/json', name: `dsh-audit-${sha256}.blob` })
    await receiver.append({ ...fact(1), turn: 1, config: { kind: 'inline', value: fixture.contextConfig } })
    const compactions = fixture.compactions as { id: string; replacementHistory: unknown[] }[]
    for (const [index, item] of compactions.entries()) {
      const sequence = 2 + index * 2
      await receiver.append({ ...compaction(sequence, 'compaction/pending', item.replacementHistory), compactionId: item.id })
      await receiver.append({ ...compaction(sequence + 1, 'compaction/installed', item.replacementHistory), compactionId: item.id })
    }
    await expect(receiver.append({
      version: 1, sequence: 6, eventId: 'checkpoint-large', time: 1, threadId: 'thread-1', turn: 1,
      kind: 'checkpoint', checkpointId: 'turn:large', effectiveHistorySha256: snapshot.effectiveHistorySha256,
      snapshot: { kind: 'artifact', sha256, bytes: data.length, mediaType: 'application/json' },
    })).resolves.toMatchObject({ sequence: 6 })
    expect(chunksRead).toBeGreaterThan(60)
  })

  it('ACKs a Rust V2 checkpoint only with matching inner hashes and installed facts', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as Record<string, unknown>
    for (const [caseName, change, accepted, installedCount] of [
      ['valid', (value: Record<string, unknown>) => value, true, 2],
      ['changed history', (value: Record<string, unknown>) => ({ ...value, effectiveHistory: [] }), false, 2],
      ['missing installed fact', (value: Record<string, unknown>) => value, false, 1],
    ] as const) {
      const snapshot = change(fixture)
      const data = Buffer.from(JSON.stringify(snapshot))
      const sha256 = createHash('sha256').update(data).digest('hex')
      const session = Session.create(SessionId(`checkpoint-${caseName}`))
      const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn(), attachmentReader(data))
      await receiver.commitArtifact({ version: 1, threadId: 'thread-1', sha256, bytes: data.length,
        mediaType: 'application/json', name: `dsh-audit-${sha256}.blob` })
      await receiver.append({ ...fact(1), turn: 1, config: { kind: 'inline', value: fixture.contextConfig } })
      const compactions = fixture.compactions as { id: string; replacementHistory: unknown[] }[]
      for (const [index, item] of compactions.slice(0, installedCount).entries()) {
        const sequence = 2 + index * 2
        await receiver.append({ ...compaction(sequence, 'compaction/pending', item.replacementHistory), compactionId: item.id })
        await receiver.append({ ...compaction(sequence + 1, 'compaction/installed', item.replacementHistory), compactionId: item.id })
      }
      const checkpoint = {
        version: 1, sequence: 2 + installedCount * 2, eventId: 'checkpoint-1', time: 1, threadId: 'thread-1', turn: 1,
        kind: 'checkpoint', checkpointId: 'turn:turn-1', effectiveHistorySha256: fixture.effectiveHistorySha256,
        snapshot: { kind: 'artifact', sha256, bytes: data.length, mediaType: 'application/json' },
      }
      if (accepted) await expect(receiver.append(checkpoint)).resolves.toMatchObject({ sequence: 2 + installedCount * 2 })
      else await expect(receiver.append(checkpoint)).rejects.toThrow(/checkpoint|history hash/)
    }
  })

  it('returns the durable cursor and accepts identical retries after a reconstructed Session', async () => {
    const session = Session.create(SessionId('audit-1'))
    const flush = vi.fn().mockResolvedValue(true)
    const failed = vi.fn()
    const receiver = new CodexAuditReceiver(session, 'thread-1', flush, failed)
    await expect(receiver.cursor()).resolves.toEqual({ version: 1, sequence: 0, eventId: null })
    await expect(receiver.append(fact(1))).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
    await expect(receiver.append(fact(1))).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
    expect(flush).toHaveBeenCalledTimes(1)

    const restored = Session.create(SessionId('audit-restored'), session.snapshotEvents())
    const resumed = new CodexAuditReceiver(restored, 'thread-1', flush, failed)
    await expect(resumed.cursor()).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
    await expect(resumed.append(fact(1))).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
    await expect(resumed.append(fact(2))).resolves.toEqual({ version: 1, sequence: 2, eventId: 'event-2' })
    expect(flush).toHaveBeenCalledTimes(2)
    expect(failed).not.toHaveBeenCalled()
  })

  it('does not acknowledge or advance until the Session flush settles', async () => {
    const session = Session.create(SessionId('audit-2'))
    const durable = Promise.withResolvers<boolean>()
    const receiver = new CodexAuditReceiver(session, 'thread-1', () => durable.promise, vi.fn())
    const ack = receiver.append(fact(1))
    const cursor = receiver.cursor()
    let settled = false
    void ack.then(() => { settled = true })
    await vi.waitFor(() => { expect(session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(1) })
    expect(settled).toBe(false)
    durable.resolve(true)
    await expect(ack).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
    await expect(cursor).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
  })

  it.each([
    ['gap', fact(2), 'sequence gap'],
    ['wrong thread', { ...fact(1), threadId: 'thread-2' }, 'another thread'],
    ['invalid version', { ...fact(1), version: 2 }, 'Invalid input'],
  ])('rejects a %s and stops later appends', async (_label, invalid, message) => {
    const session = Session.create(SessionId('audit-invalid'))
    const failed = vi.fn()
    const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, failed)
    await expect(receiver.append(invalid)).rejects.toThrow(message)
    await expect(receiver.append(fact(1))).rejects.toThrow(message)
    expect(session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(0)
    expect(failed).toHaveBeenCalledOnce()
  })

  it('rejects conflicting sequence and reused eventId without a second write', async () => {
    for (const conflicting of [
      { ...fact(1), config: { kind: 'inline', value: { model: 'changed' } } },
      fact(2, 'event-1'),
    ]) {
      const session = Session.create(SessionId('audit-conflict'))
      const flush = vi.fn().mockResolvedValue(true)
      const receiver = new CodexAuditReceiver(session, 'thread-1', flush, vi.fn())
      await receiver.append(fact(1))
      await expect(receiver.append(conflicting)).rejects.toThrow(/changed its payload|eventId reused/)
      expect(flush).toHaveBeenCalledTimes(1)
      expect(session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(1)
    }
  })

  it('fails closed when durable storage is unavailable', async () => {
    const session = Session.create(SessionId('audit-failed-flush'))
    const failed = vi.fn()
    const receiver = new CodexAuditReceiver(session, 'thread-1', async () => false, failed)
    await expect(receiver.append(fact(1))).rejects.toThrow('durable Session audit storage is unavailable')
    await expect(receiver.cursor()).rejects.toThrow('durable Session audit storage is unavailable')
    expect(failed).toHaveBeenCalledOnce()
  })

  it('serializes concurrent appends before their acknowledgments', async () => {
    const session = Session.create(SessionId('audit-concurrent'))
    const first = Promise.withResolvers<boolean>()
    let flushCount = 0
    const receiver = new CodexAuditReceiver(session, 'thread-1', () => {
      flushCount += 1
      return flushCount === 1 ? first.promise : Promise.resolve(true)
    }, vi.fn())
    const one = receiver.append(fact(1))
    const two = receiver.append(fact(2))
    await vi.waitFor(() => { expect(flushCount).toBe(1) })
    expect(session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(1)
    first.resolve(true)
    await expect(Promise.all([one, two])).resolves.toEqual([
      { version: 1, sequence: 1, eventId: 'event-1' },
      { version: 1, sequence: 2, eventId: 'event-2' },
    ])
    expect(flushCount).toBe(2)
  })

  it('restores an unresolved compaction and accepts only its matching installation', async () => {
    const session = Session.create(SessionId('audit-pending'))
    const flush = vi.fn().mockResolvedValue(true)
    const receiver = new CodexAuditReceiver(session, 'thread-1', flush, vi.fn())
    await expect(receiver.append(compaction(1, 'compaction/pending'))).resolves.toEqual({
      version: 1, sequence: 1, eventId: 'event-1',
    })

    const restored = Session.create(SessionId('audit-pending-restored'), session.snapshotEvents())
    const blocked = new CodexAuditReceiver(restored, 'thread-1', flush, vi.fn())
    await expect(blocked.cursor()).resolves.toEqual({ version: 1, sequence: 1, eventId: 'event-1' })
    await expect(blocked.append(fact(2))).rejects.toThrow('pending installation')

    const resumable = new CodexAuditReceiver(restored, 'thread-1', flush, vi.fn())
    await expect(resumable.append(compaction(2, 'compaction/installed'))).resolves.toEqual({
      version: 1, sequence: 2, eventId: 'event-2',
    })
    await expect(resumable.append(fact(3))).resolves.toEqual({
      version: 1, sequence: 3, eventId: 'event-3',
    })
  })

  it('rejects an installation without pending or with changed history or ID', async () => {
    const withoutPending = new CodexAuditReceiver(
      Session.create(SessionId('audit-no-pending')), 'thread-1', async () => true, vi.fn(),
    )
    await expect(withoutPending.append(compaction(1, 'compaction/installed')))
      .rejects.toThrow('has no pending checkpoint')

    for (const changed of [
      { ...compaction(2, 'compaction/installed'), compactionId: 'compact-2' },
      compaction(2, 'compaction/installed', ['different']),
    ]) {
      const session = Session.create(SessionId('audit-conflicting-compaction'))
      const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn())
      await receiver.append(compaction(1, 'compaction/pending'))
      await expect(receiver.append(changed)).rejects.toThrow('pending installation')
      expect(session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(1)
    }
  })

  it('durably aborts only the matching pending compaction, including after restart', async () => {
    const session = Session.create(SessionId('audit-abort'))
    const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn())
    await receiver.append(compaction(1, 'compaction/pending'))
    const restored = Session.create(SessionId('audit-abort-restored'), session.snapshotEvents())
    const resumable = new CodexAuditReceiver(restored, 'thread-1', async () => true, vi.fn())
    await expect(resumable.append(abortedCompaction(2))).resolves.toEqual({
      version: 1, sequence: 2, eventId: 'event-2',
    })
    await expect(resumable.append(fact(3))).resolves.toMatchObject({ sequence: 3 })
    const afterAbort = new CodexAuditReceiver(
      Session.create(SessionId('audit-abort-reloaded'), restored.snapshotEvents()),
      'thread-1', async () => true, vi.fn(),
    )
    await expect(afterAbort.cursor()).resolves.toMatchObject({ sequence: 3 })
  })

  it('rejects an abort without pending or with a conflicting identity or history', async () => {
    const withoutPending = new CodexAuditReceiver(
      Session.create(SessionId('audit-no-abort')), 'thread-1', async () => true, vi.fn(),
    )
    await expect(withoutPending.append(abortedCompaction(1))).rejects.toThrow('has no pending checkpoint')
    for (const changed of [
      { ...abortedCompaction(2), compactionId: 'compact-2' },
      abortedCompaction(2, ['different']),
    ]) {
      const session = Session.create(SessionId('audit-conflicting-abort'))
      const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn())
      await receiver.append(compaction(1, 'compaction/pending'))
      await expect(receiver.append(changed)).rejects.toThrow('pending installation')
      expect(session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(1)
    }
  })

  it('does not release pending if the abort cannot be flushed', async () => {
    const session = Session.create(SessionId('audit-abort-flush'))
    const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn())
    await receiver.append(compaction(1, 'compaction/pending'))
    const failedFlush = new CodexAuditReceiver(
      Session.create(SessionId('audit-abort-flush-restored'), session.snapshotEvents()),
      'thread-1', async () => false, vi.fn(),
    )
    await expect(failedFlush.append(abortedCompaction(2))).rejects.toThrow('storage is unavailable')
    await expect(failedFlush.append(fact(3))).rejects.toThrow('storage is unavailable')
  })

  it('keeps an older unanchored pending compaction fail-closed for automatic abort', async () => {
    const session = Session.create(SessionId('audit-legacy-pending'))
    const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn())
    const { priorRolloutSha256: _anchor, ...legacy } = compaction(1, 'compaction/pending')
    await receiver.append(legacy)
    const resumed = new CodexAuditReceiver(
      Session.create(SessionId('audit-legacy-pending-reloaded'), session.snapshotEvents()),
      'thread-1', async () => true, vi.fn(),
    )
    await expect(resumed.append(abortedCompaction(2))).rejects.toThrow('no prior rollout anchor')
  })

  it('verifies a session-owned artifact again after receiver restart before fact ACK', async () => {
    const data = Buffer.from('{"fullPrompt":"not redacted"}')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const session = Session.create(SessionId('audit-artifact-owner'))
    const owner = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn(), attachmentReader(data))
    await owner.commitArtifact({ version: 1, threadId: 'thread-1', sha256, bytes: data.length,
      mediaType: 'application/json', name: `dsh-audit-${sha256}.blob` })
    const restored = Session.create(SessionId('audit-artifact-restored'), session.snapshotEvents())
    const receiver = new CodexAuditReceiver(restored, 'thread-1', async () => true, vi.fn(), attachmentReader(data))
    await expect(receiver.append(artifactFact(1, sha256, data.length)))
      .resolves.toMatchObject({ sequence: 1 })
    expect(restored.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(1)
  })

  it.each([0, 2, '1', null])('rejects persisted artifact receipt version %j before resume', (version) => {
    const sha256 = 'a'.repeat(64)
    const session = Session.create(SessionId('audit-invalid-artifact-version'))
    // Persisted input can carry a version outside the current TypeScript event declaration.
    session.append('codex/artifact-v1', {
      version: version as never, threadId: 'thread-1', sha256, bytes: 0,
      mediaType: 'application/json', name: `dsh-audit-${sha256}.blob`,
    })
    const flush = vi.fn().mockResolvedValue(true)
    expect(() => new CodexAuditReceiver(session, 'thread-1', flush, vi.fn()))
      .toThrow('persisted audit artifact receipt is invalid')
    expect(flush).not.toHaveBeenCalled()
  })

  it('refuses missing, foreign, changed, and unreadable audit blobs before fact ACK', async () => {
    const data = Buffer.from('full audit payload')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const owned = Session.create(SessionId('audit-artifact-cases'))
    const receipt = { version: 1, threadId: 'thread-1', sha256, bytes: data.length,
      mediaType: 'application/json', name: `dsh-audit-${sha256}.blob` } as const
    await new CodexAuditReceiver(owned, 'thread-1', async () => true, vi.fn(), attachmentReader(data))
      .commitArtifact(receipt)
    const cases = [
      { events: [] as ReturnType<typeof owned.snapshotEvents>, reader: attachmentReader(data), error: 'not owned' },
      { events: owned.snapshotEvents(), reader: attachmentReader(Buffer.from('corrupt payload!!!')), error: 'hash or size differs' },
      { events: owned.snapshotEvents(), reader: attachmentReader(new Error('missing blob')), error: 'missing or unreadable' },
    ]
    for (const [index, testCase] of cases.entries()) {
      const session = Session.create(SessionId(`audit-artifact-case-${index}`), testCase.events)
      const receiver = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn(), testCase.reader)
      await expect(receiver.append(artifactFact(1, sha256, data.length))).rejects.toThrow(testCase.error)
      expect(session.snapshotEvents().filter(event => event.type === 'codex/audit-v1')).toHaveLength(0)
    }
  })
})
