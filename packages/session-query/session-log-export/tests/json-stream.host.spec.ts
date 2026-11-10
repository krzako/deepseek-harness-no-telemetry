import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PortableAgentContextStreamV1, PortableAgentContextV1, PortableOpaqueContextItemStreamV1 } from '@deepseek-ai/dsh-agent'
import { portableContextJsonStream, portableJsonChunks, portableJsonStream } from '../src/json-stream.ts'
import { measureDshArchiveEntry } from '../src/manifest-stream.ts'

const context: PortableAgentContextV1 = {
  version: 1,
  source: { version: 1, sessionId: 'source', driver: { id: 'standard', version: '1' },
    model: { provider: 'provider', id: 'model' } },
  items: [
    { id: 'first', role: 'user', content: [{ kind: 'text', text: 'x'.repeat(32_000) }], provenance: { kind: 'user' } },
    { id: 'second', role: 'assistant', content: [{ kind: 'text', text: 'done' }], provenance: { kind: 'model' } },
  ],
  effectiveItemIds: ['first', 'second'],
  compactions: [{ id: 'compact', mode: 'local', inputItemIds: ['first'], outputItemIds: ['second'],
    promptItemIds: ['first'], resultItemIds: ['second'] }],
}

function streamed(value: PortableAgentContextV1 = context): PortableAgentContextStreamV1 {
  return { version: value.version, source: value.source,
    items: (async function* () { yield* value.items })(),
    effectiveItemIds: (async function* () { yield* value.effectiveItemIds })(),
    compactions: (async function* () { yield* value.compactions })() }
}

describe('portable JSON ZIP stream', () => {
  it('encodes a canonical context item-by-item with exact V1 bytes', async () => {
    let yielded = 0
    const source = { ...streamed(), items: (async function* () {
      for (const item of context.items) { yielded++; yield item }
    })() }
    const reader = portableContextJsonStream(source)[Symbol.asyncIterator]()
    let prefix = ''
    while (!prefix.includes('"first"')) {
      const next = await reader.next()
      if (next.done) throw new Error('first item was not encoded')
      prefix += Buffer.from(next.value).toString('utf8')
    }
    expect(yielded).toBe(1)
    const chunks: Uint8Array[] = [Buffer.from(prefix)]
    for (;;) {
      const next = await reader.next()
      if (next.done) break
      chunks.push(next.value)
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(JSON.stringify(context)))
    expect(yielded).toBe(2)
    expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBeLessThan(25_000)
  })

  it('rejects duplicate or missing references and leaves no completed receipt', async () => {
    const malformed = { ...streamed(), compactions: (async function* () {
      yield { ...context.compactions[0]!, outputItemIds: ['missing'] }
    })() }
    const measured = measureDshArchiveEntry({ path: 'agent/context.json',
      chunks: portableContextJsonStream(malformed) }, 'portable-context')
    if (!('chunks' in measured.entry)) throw new Error('expected context stream')
    const chunks = measured.entry.chunks
    await expect((async () => { for await (const _ of chunks) { /* consume */ } })())
      .rejects.toThrow('invalid or duplicate compaction')
    expect(() => measured.receipt()).toThrow('not completely consumed')

    const duplicate = { ...streamed(), items: (async function* () {
      yield context.items[0] as PortableAgentContextV1['items'][number]
      yield context.items[0] as PortableAgentContextV1['items'][number]
    })() }
    await expect((async () => { for await (const _ of portableContextJsonStream(duplicate)) { /* consume */ } })())
      .rejects.toThrow('invalid or duplicate item')
  })
  it('matches JSON.stringify byte for byte across escapes, surrogate boundaries, and optional fields', async () => {
    const text = `${'\u0000\\"ż'.repeat(820)}\ud83d\ude00${'🙂'.repeat(4000)}`
    const value = { source: { model: 'ż', omitted: undefined }, items: [{ text }],
      private: { [`${'a'.repeat(4095)}🙂`]: [null, true, -0, 1.5] } }
    const chunks: Uint8Array[] = []
    for await (const chunk of portableJsonStream(value)) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    expect(bytes).toEqual(Buffer.from(JSON.stringify(value)))
    expect(Math.max(...chunks.map(chunk => chunk.byteLength))).toBeLessThan(25_000)
    expect(chunks.length).toBeGreaterThan(10)
  })

  it('measures only complete JSON streams and refuses a receipt after interruption', async () => {
    const value = { context: 'x'.repeat(100_000) }
    const measured = measureDshArchiveEntry({ path: 'agent/context.json', chunks: portableJsonStream(value) }, 'portable-context')
    if (!('chunks' in measured.entry)) throw new Error('expected streamed context')
    const parts: Uint8Array[] = []
    for await (const chunk of measured.entry.chunks) parts.push(chunk)
    const bytes = Buffer.concat(parts)
    expect(measured.receipt()).toEqual({ path: 'agent/context.json', kind: 'portable-context', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') })

    const interrupted = measureDshArchiveEntry({ path: 'agent/private-snapshot.json',
      chunks: portableJsonStream(value) }, 'private-snapshot')
    if (!('chunks' in interrupted.entry)) throw new Error('expected streamed checkpoint')
    const reader = interrupted.entry.chunks[Symbol.asyncIterator]()
    await reader.next()
    await reader.return?.()
    expect(() => interrupted.receipt()).toThrow('not completely consumed')
  })

  it('rejects unsupported values instead of silently changing portable JSON', () => {
    expect(() => [...portableJsonChunks({ invalid: BigInt(1) })]).toThrow('non-JSON value')
  })
})

function opaqueSource(bytes = Buffer.from('{ "nested": ["żółć", 1e2, null] }'), expected = bytes) {
  const item: PortableOpaqueContextItemStreamV1 = { encoding: 'opaque-json', id: 'opaque', role: 'developer',
    namespace: 'fixture.prompt.v1', provenance: { kind: 'compaction', sourceId: 'request' },
    json: { bytes: expected.length, sha256: createHash('sha256').update(expected).digest('hex'),
      chunks: (async function* () { for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3) })() } }
  const source: PortableAgentContextStreamV1 = { version: 1, source: context.source,
    items: (async function* () { yield item })(), effectiveItemIds: (async function* () { yield 'opaque' })(),
    compactions: (async function* () {})() }
  return { item, source }
}

describe('portable opaque JSON sources', () => {
  it('preserves validated JSON spelling inside an ordinary V1 opaque block', async () => {
    const { source } = opaqueSource()
    const parts = []
    for await (const chunk of portableContextJsonStream(source)) parts.push(chunk)
    const text = Buffer.concat(parts).toString()
    expect(text).toContain('{ "nested": ["żółć", 1e2, null] }')
    expect(JSON.parse(text)).toMatchObject({ items: [{ id: 'opaque', role: 'developer',
      content: [{ kind: 'opaque', namespace: 'fixture.prompt.v1', value: { nested: ['żółć', 100, null] } }] }],
    effectiveItemIds: ['opaque'] })
    expect(text).not.toContain('opaque-json')
  })

  it('refuses a completed entry receipt for truncated, changed or oversized JSON bytes', async () => {
    for (const bytes of [Buffer.from('[1'), Buffer.from('[2]'), Buffer.from('[1] ')]) {
      const { source } = opaqueSource(bytes, Buffer.from('[1]'))
      const measured = measureDshArchiveEntry({ path: 'agent/context.json', chunks: portableContextJsonStream(source) }, 'portable-context')
      if (!('chunks' in measured.entry)) throw new Error('expected stream')
      const chunks = measured.entry.chunks
      await expect(async () => { for await (const _chunk of chunks) { /* consume */ } }).rejects.toThrow('portable opaque stream')
      expect(() => measured.receipt()).toThrow('not completely consumed')
    }
  })

  it('closes a failed or cancelled opaque source without completing its receipt', async () => {
    for (const cancel of [false, true]) {
      let closed = false
      const { item, source } = opaqueSource(Buffer.from('[1]'))
      const broken = { ...item, json: { ...item.json, chunks: (async function* () {
        try { yield Buffer.from('[1'); throw new Error('opaque read failed') }
        finally { closed = true }
      })() } }
      const measured = measureDshArchiveEntry({ path: 'agent/context.json',
        chunks: portableContextJsonStream({ ...source, items: (async function* () { yield broken })() }) }, 'portable-context')
      if (!('chunks' in measured.entry)) throw new Error('expected stream')
      const chunks = measured.entry.chunks
      const consume = async () => {
        for await (const chunk of chunks) {
          if (cancel && Buffer.from(chunk).toString() === '[1') break
        }
      }
      if (cancel) await consume()
      else await expect(consume()).rejects.toThrow('opaque read failed')
      expect(closed).toBe(true)
      expect(() => measured.receipt()).toThrow('not completely consumed')
    }
  })

  it('checks opaque metadata and ordinary reference rules', async () => {
    for (const change of [{ namespace: '' }, { id: '' }, { role: 'invalid' }]) {
      const { item, source } = opaqueSource()
      Object.assign(item, change)
      await expect(async () => { for await (const _chunk of portableContextJsonStream(source)) { /* consume */ } })
        .rejects.toThrow('invalid metadata')
    }
    const { item, source } = opaqueSource()
    const duplicate = { ...source, items: (async function* () { yield item; yield item })() }
    await expect(async () => { for await (const _chunk of portableContextJsonStream(duplicate)) { /* consume */ } })
      .rejects.toThrow('invalid or duplicate item')
  })
})
