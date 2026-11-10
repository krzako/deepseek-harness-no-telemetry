import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { codexJsonSha256 } from '../src/context-snapshot.ts'
import { codexPortableArtifactStream, codexPortablePayloadResolver } from '../src/portable-artifact.ts'

function artifact(data: Buffer) {
  const sha256 = createHash('sha256').update(data).digest('hex')
  return { kind: 'artifact' as const, sha256, bytes: data.byteLength, mediaType: 'application/json' }
}

function session(sha256: string, bytes: number, threadId = 'thread-1'): Session {
  const result = Session.create(SessionId('portable-artifact'))
  result.append('codex/artifact-v1', { version: 1, threadId, sha256, bytes,
    mediaType: 'application/json', name: `dsh-audit-${sha256}.blob` })
  return result
}

function store(data: Buffer, onRead?: (ref: FileAttachmentRef) => void): AttachmentStore {
  return { async *readFileStream(ref: FileAttachmentRef) {
    onRead?.(ref)
    for (let offset = 0; offset < data.byteLength; offset += 7) yield data.subarray(offset, offset + 7)
  } } as unknown as AttachmentStore
}

describe('Codex portable artifact resolver', () => {
  it('streams exact receipt-owned bytes and rejects truncated, changed, and foreign artifacts', async () => {
    const data = Buffer.from(JSON.stringify({ prompt: 'large '.repeat(20) }))
    const payload = artifact(data)
    const refs: FileAttachmentRef[] = []
    const stream = codexPortableArtifactStream(session(payload.sha256, payload.bytes), 'thread-1',
      store(data, ref => refs.push(ref)))
    const chunks: Uint8Array[] = []
    for await (const chunk of stream(payload)) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(data)
    expect(chunks.length).toBeGreaterThan(1)
    expect(refs).toEqual([{ attachmentId: `sha256:${payload.sha256}`, bytes: payload.bytes,
      name: `dsh-audit-${payload.sha256}.blob` }])
    const consume = async (reader: ReturnType<typeof codexPortableArtifactStream>) => {
      for await (const chunk of reader(payload)) void chunk
    }
    await expect(consume(codexPortableArtifactStream(session(payload.sha256, payload.bytes), 'thread-1',
      store(data.subarray(0, 4))))).rejects.toThrow('hash or size differs')
    await expect(consume(codexPortableArtifactStream(session(payload.sha256, payload.bytes), 'thread-1',
      store(Buffer.from(data.toString().replace('large', 'other')))))).rejects.toThrow('hash or size differs')
    await expect(consume(codexPortableArtifactStream(Session.create(SessionId('foreign')), 'thread-1',
      store(data)))).rejects.toThrow('not owned by this Session')
  })

  it('reads exact JSON bytes only through the owning receipt and digest-derived reference', async () => {
    const data = Buffer.from(JSON.stringify({ prompt: 'complete', nested: [1, true, null] }))
    const payload = artifact(data)
    const refs: FileAttachmentRef[] = []
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1',
      store(data, ref => refs.push(ref)))
    expect(await resolve(payload)).toEqual({ prompt: 'complete', nested: [1, true, null] })
    expect(refs).toEqual([{ attachmentId: `sha256:${payload.sha256}`, bytes: data.byteLength,
      name: `dsh-audit-${payload.sha256}.blob` }])
    expect(await resolve({ kind: 'inline', value: { preserved: 'text' } })).toEqual({ preserved: 'text' })
  })

  it('rejects foreign receipts, missing ownership, changed bytes, and invalid JSON', async () => {
    const data = Buffer.from('{"value":1}')
    const payload = artifact(data)
    expect(() => codexPortablePayloadResolver(session(payload.sha256, payload.bytes, 'other-thread'),
      'thread-1', store(data))).toThrow('foreign, invalid, or duplicate')
    await expect(codexPortablePayloadResolver(Session.create(SessionId('no-receipt')), 'thread-1', store(data))(payload))
      .rejects.toThrow('not owned by this Session')
    await expect(codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1',
      store(Buffer.from('{"value":2}')))(payload)).rejects.toThrow('hash or size differs')
    await expect(codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1',
      store(data.subarray(0, 3)))(payload)).rejects.toThrow('hash or size differs')
    const invalid = Buffer.from('{invalid')
    const invalidPayload = artifact(invalid)
    await expect(codexPortablePayloadResolver(session(invalidPayload.sha256, invalidPayload.bytes), 'thread-1',
      store(invalid))(invalidPayload)).rejects.toThrow('not valid JSON')
  })

  it('rejects receipt metadata conflicts and unreadable storage', async () => {
    const data = Buffer.from('[]')
    const payload = artifact(data)
    const result = session(payload.sha256, payload.bytes)
    result.append('codex/artifact-v1', { version: 1, threadId: 'thread-1', sha256: payload.sha256,
      bytes: payload.bytes, mediaType: 'application/json', name: `dsh-audit-${payload.sha256}.blob` })
    expect(() => codexPortablePayloadResolver(result, 'thread-1', store(data)))
      .toThrow('foreign, invalid, or duplicate')
    const missing = { async *readFileStream() { throw new Error('disk offline') } } as unknown as AttachmentStore
    await expect(codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', missing)(payload))
      .rejects.toThrow('missing or unreadable')
    await expect(codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', store(data))({
      ...payload, mediaType: 'application/octet-stream',
    })).rejects.toThrow('not owned by this Session')
  })
})

describe('Codex artifact history digests', () => {
  it('matches canonical hashing for chunked Unicode, nested values, numbers and empty history', async () => {
    for (const value of [[], [null, true, 0, 1.25, 'żółć', { z: [1, false], a: 'text' }]]) {
      const data = Buffer.from(JSON.stringify(value))
      const payload = artifact(data)
      let reads = 0
      const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1',
        store(data, () => { reads++ }))
      expect(await resolve.historySha256(payload)).toBe(codexJsonSha256(value))
      expect(reads).toBe(2)
      expect(await resolve.historySha256({ kind: 'inline', value })).toBe(codexJsonSha256(value))
    }
  })

  it('rejects non-array, malformed and non-lossless histories', async () => {
    for (const text of ['{}', 'null', '[1', '[1] trailing', '[1e999]', '[-0]']) {
      const data = Buffer.from(text)
      const payload = artifact(data)
      const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', store(data))
      await expect(resolve.historySha256(payload)).rejects.toThrow()
    }
    const resolve = codexPortablePayloadResolver(Session.create(SessionId('inline-history')), 'thread-1', store(Buffer.from('[]')))
    await expect(resolve.historySha256({ kind: 'inline', value: {} })).rejects.toThrow('not a JSON array')
  })

  it('closes the artifact byte source when a history consumer stops early', async () => {
    const data = Buffer.from(JSON.stringify(Array.from({ length: 10000 }, () => ({ text: 'x'.repeat(100) }))))
    const payload = artifact(data)
    let bytesRead = 0
    let signalClosed: () => void = () => undefined
    const closed = new Promise<void>((resolve) => { signalClosed = resolve })
    const source = { async *readFileStream() {
      try {
        for (let offset = 0; offset < data.length; offset += 128) {
          const chunk = data.subarray(offset, offset + 128)
          bytesRead += chunk.length
          yield chunk
        }
      } finally { signalClosed() }
    } } as unknown as AttachmentStore
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', source)
    for await (const item of resolve.historyItems(payload)) {
      expect(item).toEqual({ text: 'x'.repeat(100) })
      break
    }
    await closed
    expect(bytesRead).toBeLessThan(data.length)
  })

  it('rejects a changed second read and closes both storage reads', async () => {
    const data = Buffer.from('[1,2]')
    const payload = artifact(data)
    let reads = 0
    let closed = 0
    const changed = { async *readFileStream() {
      reads++
      try { yield reads === 1 ? data : Buffer.from('[1,3]') }
      finally { closed++ }
    } } as unknown as AttachmentStore
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', changed)
    await expect(resolve.historySha256(payload)).rejects.toThrow('hash or size differs')
    expect(reads).toBe(2)
    expect(closed).toBe(2)
  })
})


describe('Codex opaque artifact ownership', () => {
  it('closes a verified opaque reader when export consumption is cancelled', async () => {
    const data = Buffer.from(JSON.stringify({ text: 'x'.repeat(10000) }))
    const payload = artifact(data)
    let closed = 0
    let readBytes = 0
    const source = { async *readFileStream() {
      try {
        for (let offset = 0; offset < data.length; offset += 128) {
          const chunk = data.subarray(offset, offset + 128)
          readBytes += chunk.length
          yield chunk
        }
      } finally { closed++ }
    } } as unknown as AttachmentStore
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', source)
    const admitted = await resolve.opaqueJson(payload, false)
    if (admitted === null || typeof admitted !== 'object' || !('read' in admitted) || typeof admitted.read !== 'function') {
      throw new Error('expected streamed artifact')
    }
    expect(closed).toBe(1)
    readBytes = 0
    for await (const chunk of admitted.read()) { expect(chunk.length).toBeGreaterThan(0); break }
    expect(closed).toBe(2)
    expect(readBytes).toBeLessThan(data.length)
  })

  it('verifies ownership before admission and rechecks bytes on consumption', async () => {
    const data = Buffer.from('{"value":1}')
    const payload = artifact(data)
    const foreign = codexPortablePayloadResolver(Session.create(SessionId('foreign-opaque')), 'thread-1', store(data))
    await expect(foreign.opaqueJson(payload, false)).rejects.toThrow('not owned')
    let reads = 0
    let closed = 0
    const changed = { async *readFileStream() {
      try { yield ++reads === 1 ? data : Buffer.from('{"value":2}') } finally { closed++ }
    } } as unknown as AttachmentStore
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', changed)
    const admitted = await resolve.opaqueJson(payload, false)
    if (admitted === null || typeof admitted !== 'object' || !('read' in admitted) || typeof admitted.read !== 'function') {
      throw new Error('expected streamed artifact')
    }
    const read = admitted.read
    await expect((async () => { for await (const chunk of read()) void chunk })()).rejects.toThrow('hash or size differs')
    expect(closed).toBe(2)
  })
})


describe('Codex streamed configuration comparison', () => {
  it('compares complete properties independently of key order and honors last duplicate keys', async () => {
    const expected = { schemaVersion: 1, instructions: 'żółć'.repeat(10000), nested: { a: [true, null], b: 2 } }
    const data = Buffer.from(JSON.stringify({ nested: { b: 2, a: [true, null] }, instructions: expected.instructions, schemaVersion: 1 }))
    const payload = artifact(data)
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', store(data))
    expect(await resolve.configurationMatches(payload, expected)).toBe(true)
    expect(await resolve.configurationMatches(payload, { ...expected, instructions: 'different' })).toBe(false)
    expect(await resolve.configurationMatches(payload, { ...expected, extra: true })).toBe(false)
    expect(await resolve.configurationMatches(payload, { schemaVersion: 1 })).toBe(false)
    expect(await resolve.configurationMatches({ kind: 'inline', value: expected }, expected)).toBe(true)
    const duplicates = Buffer.from('{"schemaVersion":0,"schemaVersion":1}')
    const duplicatePayload = artifact(duplicates)
    const duplicateResolver = codexPortablePayloadResolver(session(duplicatePayload.sha256, duplicatePayload.bytes), 'thread-1', store(duplicates))
    expect(await duplicateResolver.configurationMatches(duplicatePayload, { schemaVersion: 1 })).toBe(true)
  })

  it.each(['[]', 'null', '{"schemaVersion":1} trailing', '{"schemaVersion":1,"value":-0}', '{"value":1e999}', '{'])
  ('rejects incomplete, non-object or non-lossless configuration %s', async (text) => {
    const data = Buffer.from(text)
    const payload = artifact(data)
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', store(data))
    await expect(resolve.configurationMatches(payload, { schemaVersion: 1 })).rejects.toThrow()
  })

  it('checks ownership and full receipt even after a property mismatch', async () => {
    const data = Buffer.from('{"schemaVersion":1}')
    const payload = artifact(data)
    const foreign = codexPortablePayloadResolver(Session.create(SessionId('foreign-config')), 'thread-1', store(data))
    await expect(foreign.configurationMatches(payload, { schemaVersion: 1 })).rejects.toThrow('not owned')
    let closed = false
    const changed = { async *readFileStream() {
      try { yield Buffer.from('{"schemaVersion":2}') } finally { closed = true }
    } } as unknown as AttachmentStore
    const resolve = codexPortablePayloadResolver(session(payload.sha256, payload.bytes), 'thread-1', changed)
    await expect(resolve.configurationMatches(payload, { schemaVersion: 1 })).rejects.toThrow('hash or size differs')
    expect(closed).toBe(true)
  })
})
