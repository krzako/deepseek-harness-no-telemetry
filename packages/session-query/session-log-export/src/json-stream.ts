/** Encode validated portable JSON without constructing one full output string. */

import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  isAgentDriverStateV1, isPortableCompactionV1, isPortableContextItemV1,
  type PortableAgentContextStreamV1, type PortableContextItemV1, type PortableOpaqueContextItemStreamV1,
} from '@deepseek-ai/dsh-agent'

const STRING_CHARS_PER_CHUNK = 4096

function* quotedString(value: string): Generator<Uint8Array> {
  yield Buffer.from('"')
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + STRING_CHARS_PER_CHUNK, value.length)
    const last = value.charCodeAt(end - 1)
    const next = value.charCodeAt(end)
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++
    yield Buffer.from(JSON.stringify(value.slice(start, end)).slice(1, -1))
    start = end
  }
  yield Buffer.from('"')
}

/**
 * Stream the same UTF-8 bytes as `JSON.stringify` for validated portable data.
 * Long keys and string values are escaped in bounded pieces. This only limits
 * output encoding; the source object still belongs to the caller in memory.
 * @param value - validated canonical context or private checkpoint.
 * @returns JSON byte chunks in document order.
 */
export function* portableJsonChunks(value: unknown): Generator<Uint8Array> {
  if (typeof value === 'string') {
    yield* quotedString(value)
  } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    yield Buffer.from(JSON.stringify(value))
  } else if (Array.isArray(value)) {
    yield Buffer.from('[')
    for (let index = 0; index < value.length; index++) {
      if (index > 0) yield Buffer.from(',')
      yield* portableJsonChunks(value[index] === undefined ? null : value[index])
    }
    yield Buffer.from(']')
  } else if (typeof value === 'object') {
    yield Buffer.from('{')
    let written = 0
    for (const key of Object.keys(value)) {
      const item: unknown = (value as Record<string, unknown>)[key]
      if (item === undefined) continue
      if (written++ > 0) yield Buffer.from(',')
      yield* quotedString(key)
      yield Buffer.from(':')
      yield* portableJsonChunks(item)
    }
    yield Buffer.from('}')
  } else {
    throw new TypeError('portable ZIP cannot encode a non-JSON value')
  }
}

/**
 * Adapt synchronous JSON chunks to the ZIP entry's backpressured async stream.
 * @param value - validated canonical context or private checkpoint.
 * @returns ordered UTF-8 chunks without a full serialized string.
 */
export function portableJsonStream(value: unknown): AsyncIterable<Uint8Array> {
  return Readable.from(portableJsonChunks(value), { objectMode: false, highWaterMark: 1 })
}

async function* opaqueItemJson(item: PortableOpaqueContextItemStreamV1): AsyncGenerator<Uint8Array> {
  const { chunks, bytes, sha256 } = item.json
  const metadata = structuredClone({ id: item.id, role: item.role, namespace: item.namespace, provenance: item.provenance })
  const ordinary = { id: metadata.id, role: metadata.role,
    content: [{ kind: 'opaque', namespace: metadata.namespace, value: null }], provenance: metadata.provenance }
  if (!isPortableContextItemV1(ordinary) || !Number.isSafeInteger(bytes) || bytes < 1
    || !/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError('portable opaque stream has invalid metadata')
  yield Buffer.from(`{"id":${JSON.stringify(metadata.id)},"role":${JSON.stringify(metadata.role)},"content":[{"kind":"opaque","namespace":${JSON.stringify(metadata.namespace)},"value":`)
  const hash = createHash('sha256')
  let seen = 0
  for await (const chunk of chunks) {
    seen += chunk.byteLength
    if (!Number.isSafeInteger(seen) || seen > bytes) throw new Error('portable opaque stream exceeded declared size')
    hash.update(chunk)
    yield chunk
  }
  if (seen !== bytes || hash.digest('hex') !== sha256) throw new Error('portable opaque stream hash or size differs')
  yield Buffer.from('}],"provenance":')
  yield* portableJsonChunks(metadata.provenance)
  yield Buffer.from('}')
}

/** Encode and validate one canonical context without retaining its item array.
 * Reference sets retain only identifiers; an invalid or interrupted source never
 * emits a valid final ZIP receipt when wrapped by `measureDshArchiveEntry`.
 * @param context - single-consumption driver stream in canonical field order.
 * @param onItem - optional attachment/reference check before emitting each item.
 * @returns V1 JSON bytes; opaque byte sources preserve their validated JSON spelling.
 */
export async function* portableContextJsonStream(
  context: PortableAgentContextStreamV1,
  onItem?: (item: PortableContextItemV1 | PortableOpaqueContextItemStreamV1) => void,
): AsyncGenerator<Uint8Array> {
  const version: unknown = context.version
  const source = structuredClone(context.source)
  if (version !== 1 || !isAgentDriverStateV1(source)) {
    throw new TypeError('portable context stream has invalid source state')
  }
  yield Buffer.from('{"version":1,"source":')
  yield* portableJsonChunks(source)
  yield Buffer.from(',"items":[')
  const itemIds = new Set<string>()
  let first = true
  for await (const item of context.items) {
    const opaque = 'encoding' in item
    const snapshot = opaque ? { ...structuredClone({ encoding: item.encoding, id: item.id, role: item.role,
      namespace: item.namespace, provenance: item.provenance }), json: { ...item.json } } : structuredClone(item)
    if ((!opaque && !isPortableContextItemV1(snapshot)) || itemIds.has(snapshot.id)) {
      throw new TypeError('portable context stream has an invalid or duplicate item')
    }
    onItem?.(snapshot)
    itemIds.add(snapshot.id)
    if (!first) yield Buffer.from(',')
    first = false
    if ('encoding' in snapshot) yield* opaqueItemJson(snapshot)
    else yield* portableJsonChunks(snapshot)
  }
  yield Buffer.from('],"effectiveItemIds":[')
  const effectiveIds = new Set<string>()
  first = true
  for await (const id of context.effectiveItemIds) {
    if (typeof id !== 'string' || id.length === 0 || !itemIds.has(id) || effectiveIds.has(id)) {
      throw new TypeError('portable context stream has an invalid effective item reference')
    }
    effectiveIds.add(id)
    if (!first) yield Buffer.from(',')
    first = false
    yield* portableJsonChunks(id)
  }
  yield Buffer.from('],"compactions":[')
  const compactionIds = new Set<string>()
  first = true
  for await (const compaction of context.compactions) {
    const snapshot = structuredClone(compaction)
    if (!isPortableCompactionV1(snapshot, itemIds) || compactionIds.has(snapshot.id)) {
      throw new TypeError('portable context stream has an invalid or duplicate compaction')
    }
    compactionIds.add(snapshot.id)
    if (!first) yield Buffer.from(',')
    first = false
    yield* portableJsonChunks(snapshot)
  }
  yield Buffer.from(']}')
}
