import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { completeDshArchiveManifestV1, createDshArchiveResourceBudget,
  measureDshArchiveEntry } from '../src/manifest-stream.ts'

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

describe('streamed DSH archive manifest', () => {
  it('records exact UTF-8 text and binary bytes before building a validated manifest', () => {
    const log = measureDshArchiveEntry({ path: 'session.v3.jsonl', content: 'ż\n' }, 'session-log')
    const driver = measureDshArchiveEntry({ path: 'agent/driver.json', data: Uint8Array.of(1, 2) }, 'driver-state')
    const context = measureDshArchiveEntry({ path: 'agent/context.json', content: '{}' }, 'portable-context')
    expect(log.receipt()).toEqual({ path: 'session.v3.jsonl', kind: 'session-log', bytes: 3, sha256: sha256('ż\n') })
    expect(driver.receipt()).toEqual({ path: 'agent/driver.json', kind: 'driver-state', bytes: 2,
      sha256: sha256(Uint8Array.of(1, 2)) })
    const manifest = completeDshArchiveManifestV1({
      rootSessionId: 'session-1', sessionLogPath: 'session.v3.jsonl',
      driverStatePath: 'agent/driver.json', contextPath: 'agent/context.json',
      privateSnapshotPath: null,
      workspace: { sourceCwd: null, fingerprint: null, snapshot: null },
    }, [log.receipt(), driver.receipt(), context.receipt()])
    expect(manifest.version).toBe(1)
    expect(manifest.entries).toHaveLength(3)
    expect(() => completeDshArchiveManifestV1(manifest, [log.receipt(), log.receipt(), context.receipt()]))
      .toThrow('invalid archive manifest')
  })

  it('yields large file chunks without retaining them and acknowledges only complete consumption', async () => {
    const chunks = [Uint8Array.of(1, 2), Uint8Array.of(3, 4), Uint8Array.of(5)]
    let consumed = 0
    const measured = measureDshArchiveEntry({ path: 'files/large.bin', chunks: (async function* () {
      for (const chunk of chunks) { consumed += 1; yield chunk }
    })() }, 'attachment')
    expect(consumed).toBe(0)
    expect(() => measured.receipt()).toThrow('not completely consumed')
    const iterator = 'chunks' in measured.entry ? measured.entry.chunks[Symbol.asyncIterator]() : undefined
    expect(iterator).toBeDefined()
    if (iterator === undefined) throw new Error('expected streamed entry')
    expect((await iterator.next()).value).toEqual(chunks[0])
    expect(consumed).toBe(1)
    expect(() => measured.receipt()).toThrow('not completely consumed')
    await iterator.next()
    await iterator.next()
    await iterator.next()
    expect(measured.receipt()).toEqual({ path: 'files/large.bin', kind: 'attachment', bytes: 5,
      sha256: sha256(Uint8Array.of(1, 2, 3, 4, 5)) })
  })

  it('withholds a receipt after interrupted or failed streams', async () => {
    const interrupted = measureDshArchiveEntry({ path: 'files/interrupted', chunks: (async function* () {
      yield Uint8Array.of(1)
      yield Uint8Array.of(2)
    })() }, 'attachment')
    if (!('chunks' in interrupted.entry)) throw new Error('expected streamed entry')
    const iterator = interrupted.entry.chunks[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    expect(() => interrupted.receipt()).toThrow('not completely consumed')

    const failed = measureDshArchiveEntry({ path: 'files/failed', chunks: (async function* () {
      yield Uint8Array.of(1)
      throw new Error('disk read failed')
    })() }, 'attachment')
    const failedEntry = failed.entry
    if (!('chunks' in failedEntry)) throw new Error('expected streamed entry')
    const consume = async () => { for await (const _chunk of failedEntry.chunks) { /* read */ } }
    await expect(consume()).rejects.toThrow('disk read failed')
    expect(() => failed.receipt()).toThrow('not completely consumed')
  })

  it('enforces optional per-entry and total byte limits before emitting excess chunks', async () => {
    const budget = createDshArchiveResourceBudget({ maxEntryBytes: 3, maxTotalUncompressedBytes: 5 })
    const first = measureDshArchiveEntry({ path: 'agent/driver.json', content: 'ab' }, 'driver-state', budget)
    expect(first.receipt().bytes).toBe(2)
    const context = measureDshArchiveEntry({ path: 'agent/context.json', chunks: (async function* () {
      yield Uint8Array.of(1, 2)
      yield Uint8Array.of(3, 4)
    })() }, 'portable-context', budget)
    if (!('chunks' in context.entry)) throw new Error('expected streamed context')
    const reader = context.entry.chunks[Symbol.asyncIterator]()
    expect((await reader.next()).value).toEqual(Uint8Array.of(1, 2))
    await expect(reader.next()).rejects.toThrow('maxEntryBytes')
    expect(() => context.receipt()).toThrow('not completely consumed')
    expect(() => completeDshArchiveManifestV1({
      rootSessionId: 'session-1', sessionLogPath: 'session.v3.jsonl',
      driverStatePath: 'agent/driver.json', contextPath: 'agent/context.json',
      privateSnapshotPath: null, workspace: { sourceCwd: null, fingerprint: null, snapshot: null },
    }, [first.receipt(), context.receipt()])).toThrow('not completely consumed')
    expect(() => measureDshArchiveEntry({ path: 'agent/private-snapshot.json', content: '1234' },
      'private-snapshot', budget)).toThrow('maxEntryBytes')
    expect(() => measureDshArchiveEntry({ path: 'manifest.json', content: '12' },
      'private-snapshot', budget)).toThrow('maxTotalUncompressedBytes')
  })

  it('rejects invalid resource policies and leaves archive bytes unlimited when absent', async () => {
    for (const maxEntryBytes of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createDshArchiveResourceBudget({ maxEntryBytes })).toThrow('positive safe integers')
    }
    const budget = createDshArchiveResourceBudget()
    const measured = measureDshArchiveEntry({ path: 'agent/context.json', chunks: (async function* () {
      yield new Uint8Array(100_000)
    })() }, 'portable-context', budget)
    if (!('chunks' in measured.entry)) throw new Error('expected streamed context')
    for await (const _chunk of measured.entry.chunks) { /* consume */ }
    expect(measured.receipt().bytes).toBe(100_000)
  })
})
