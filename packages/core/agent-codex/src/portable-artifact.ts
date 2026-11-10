/** Session-owned, content-verified JSON for portable Codex audit facts. */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Readable, type Duplex } from 'node:stream'
import { parser } from 'stream-json'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import { streamObject } from 'stream-json/streamers/stream-object.js'
import { admitCodexPortableJson, type CodexPortableJsonStream } from './portable-json.ts'
import { codexJsonArraySha256 } from './context-snapshot.ts'
import { AttachmentId, type AttachmentStore, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Session } from '@deepseek-ai/dsh-session'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CodexAuditPayloadV1 } from './audit-contract.ts'

interface Receipt {
  readonly threadId: string
  readonly sha256: string
  readonly bytes: number
  readonly mediaType: string
  readonly name: string
}

type ArtifactPayload = Extract<CodexAuditPayloadV1, { readonly kind: 'artifact' }>

function ownedReceipts(session: Session, threadId: string): Map<string, Receipt> {
  const receipts = new Map<string, Receipt>()
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'codex/artifact-v1') continue
    const receipt = event.data
    const version: unknown = receipt.version
    if (version !== 1 || receipt.threadId !== threadId || !/^[0-9a-f]{64}$/u.test(receipt.sha256)
      || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0
      || receipt.mediaType !== 'application/json'
      || receipt.name !== `dsh-audit-${receipt.sha256}.blob` || receipts.has(receipt.sha256)) {
      throw new Error('Codex portable source has a foreign, invalid, or duplicate artifact receipt')
    }
    receipts.set(receipt.sha256, receipt)
  }
  return receipts
}

/** Read one session-owned artifact without retaining its complete byte sequence.
 * The caller must consume the iterable fully before trusting its size and hash.
 * @param session - complete durable source Session.
 * @param threadId - thread bound to that Session.
 * @param attachments - content-addressed DSH attachment store.
 * @returns a single-consumption, byte-verified artifact reader.
 */
export function codexPortableArtifactStream(
  session: Session,
  threadId: string,
  attachments: Pick<AttachmentStore, 'readFileStream'>,
): (payload: ArtifactPayload) => AsyncIterable<Uint8Array> {
  const receipts = ownedReceipts(session, threadId)
  return async function* (payload): AsyncGenerator<Uint8Array> {
    const receipt = receipts.get(payload.sha256)
    if (receipt === undefined || receipt.bytes !== payload.bytes || receipt.mediaType !== payload.mediaType) {
      throw new Error(`Codex portable artifact ${payload.sha256} is not owned by this Session`)
    }
    const ref: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${receipt.sha256}`), name: receipt.name, bytes: receipt.bytes,
    }
    const hash = createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of attachments.readFileStream(ref)) {
        bytes += chunk.byteLength
        if (!Number.isSafeInteger(bytes) || bytes > receipt.bytes) {
          throw new Error('Codex portable artifact exceeded its declared size')
        }
        hash.update(chunk)
        yield chunk
      }
    } catch (cause) {
      throw new Error(`Codex portable artifact ${payload.sha256} is missing or unreadable`, { cause })
    }
    if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256) {
      throw new Error(`Codex portable artifact ${payload.sha256} hash or size differs`)
    }
  }
}

/**
 * Resolve JSON payloads only through durable receipts of the owning Session.
 * The payload supplies a digest, not a path. The attachment store must return
 * the declared exact bytes before JSON is exposed to context projection.
 * @param session - complete durable source Session.
 * @param threadId - thread bound to that Session.
 * @param attachments - content-addressed DSH attachment store.
 * History digests consume artifact arrays twice, one element at a time; both
 * reads verify ownership, size, hash, and JSON before returning the digest.
 * History iterators must reach EOF before their receipt is trusted. Early
 * cancellation closes the byte reader and does not admit a complete history.
 * Opaque artifact admission validates a single lossless JSON value and prompt
 * implementation before exposing fresh receipt-checked bytes for the archive.
 * Configuration comparison retains one top-level property at a time, independently
 * of property order, and confirms the full artifact receipt even on a mismatch.
 * @returns a JSON resolver with history, configuration comparison and opaque-stream operations.
 */
export function codexPortablePayloadResolver(
  session: Session,
  threadId: string,
  attachments: Pick<AttachmentStore, 'readFileStream'>,
): ((payload: CodexAuditPayloadV1) => Promise<JsonValue>) & {
  configurationMatches(payload: CodexAuditPayloadV1, expected: JsonValue): Promise<boolean>
  opaqueJson(payload: CodexAuditPayloadV1, prompt: boolean): Promise<JsonValue | CodexPortableJsonStream>
  historySha256(payload: CodexAuditPayloadV1): Promise<string>
  historyItems(payload: CodexAuditPayloadV1): AsyncIterable<JsonValue>
} {
  const stream = codexPortableArtifactStream(session, threadId, attachments)
  const resolve = async (payload: CodexAuditPayloadV1): Promise<JsonValue> => {
    if (payload.kind === 'inline') return payload.value
    const chunks: Uint8Array[] = []
    for await (const chunk of stream(payload)) chunks.push(Buffer.from(chunk))
    let value: unknown
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch (cause) {
      throw new Error(`Codex portable artifact ${payload.sha256} is not valid JSON`, { cause })
    }
    if (!isJsonValue(value)) throw new Error(`Codex portable artifact ${payload.sha256} is not lossless JSON`)
    return value as JsonValue
  }
  const historyItems = async function* (payload: CodexAuditPayloadV1): AsyncGenerator<JsonValue> {
    if (payload.kind === 'inline') {
      if (!Array.isArray(payload.value) || !payload.value.every(isJsonValue)) {
        throw new Error('Codex portable history is not a JSON array')
      }
      yield* payload.value
      return
    }
    const decoded = Readable.from(stream(payload))
      .compose<Duplex>(parser.asStream()).compose<Duplex>(streamArray.asStream())
    for await (const item of decoded) {
      const value: unknown = (item as { value: unknown }).value
      if (!isJsonValue(value)) throw new Error('Codex portable history contains non-JSON data')
      yield value as JsonValue
    }
  }
  const historySha256 = async (payload: CodexAuditPayloadV1): Promise<string> => {
    let count = 0
    for await (const _item of historyItems(payload)) count++
    return codexJsonArraySha256(count, historyItems(payload))
  }
  const opaqueJson = async (payload: CodexAuditPayloadV1, prompt: boolean): Promise<JsonValue | CodexPortableJsonStream> => {
    if (payload.kind === 'inline') return payload.value
    return admitCodexPortableJson(() => stream(payload), payload, prompt)
  }
  const configurationMatches = async (payload: CodexAuditPayloadV1, expected: JsonValue): Promise<boolean> => {
    if (payload.kind === 'inline') return isDeepStrictEqual(payload.value, expected)
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
      throw new Error('Codex checkpoint configuration is not an object')
    }
    const text = async function* () {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      for await (const chunk of stream(payload)) yield decoder.decode(chunk, { stream: true })
      yield decoder.decode()
    }
    const properties = Readable.from(text()).compose<Duplex>(parser.asStream())
      .compose<Duplex>(streamObject.asStream())
    const seen = new Set<string>()
    const differences = new Set<string>()
    for await (const property of properties) {
      const { key, value } = property as { key: string; value: unknown }
      if (!isJsonValue(value)) throw new Error('Codex portable configuration contains non-JSON data')
      seen.add(key)
      if (Object.hasOwn(expected, key) && isDeepStrictEqual(value, expected[key])) differences.delete(key)
      else differences.add(key)
    }
    return differences.size === 0 && seen.size === Object.keys(expected).length
  }
  return Object.assign(resolve, { historySha256, historyItems, opaqueJson, configurationMatches })
}
