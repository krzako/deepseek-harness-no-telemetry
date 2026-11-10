/**
 * Host-side session-log download: streams one ZIP archive whose files are the
 * sessions' logical session logs plus every referenced attachment. Each log
 * is read through a persistence read handle and serialized here as canonical
 * JSONL — one header line, then one line per validated event — so every
 * backend (JSONL, SQLite, future) exports identically. The root log uses the
 * current generation's canonical `session[.vN].jsonl` name; each subagent
 * descendant uses `subagents/<id>/session[.vN].jsonl`; each image referenced by any included log
 * under `media/<id-without-sha256-prefix>.<ext>` (content-addressed, so one archive never
 * duplicates a shared image); each generic file sits under
 * `files/<prefix>/<digest>/<name>` and streams from the attachment store.
 * Session-owned Codex audit blobs stream once under `audit/<sha256>.blob`,
 * with receipt and byte-integrity checks. The default log export has no manifest;
 * the explicit portable export adds one. Before each live session's log read,
 * the SessionStore flush barrier makes the current in-memory log durable; a live session with
 * no durability listener cannot be exported. Cold sessions need no barrier.
 * Request abort and response-consumer cancellation share one producer
 * signal and terminate the active compressor.
 * Compression runs on the host with fflate's streaming Zip API, so the archive
 * bytes are produced incrementally and the host never holds the whole archive
 * in one buffer; production waits for consumer pull whenever the response queue
 * reaches its byte high-water mark, so a slow consumer bounds accumulation to
 * the fixed 64 KiB response queue plus one synchronous fflate push.
 * @module
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseCodexAuditEventV1, verifyCodexCheckpointArtifactV2,
  type CodexAuditEventV1, type CodexAuditPayloadV1 } from '@deepseek-ai/dsh-agent-codex'
import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore, FileAttachmentRef, ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { SessionLineageNode, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import type { SessionEvent, SessionHeader, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'

/** Valid fflate DEFLATE levels accepted by session-log export. */
export type SessionLogCompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

/** Balanced default used when Session export configuration omits a compression level. */
export const DEFAULT_SESSION_LOG_COMPRESSION_LEVEL: SessionLogCompressionLevel = 6

/** The services a session-log export needs (the live-session store is optional). */
export interface SessionLogExportDeps {
  readonly sessionQuery: SessionQueryEngine | undefined
  readonly sessionPersistence: SessionPersistence | undefined
  readonly attachments: AttachmentStore | undefined
  readonly sessions: SessionStore | undefined
}

/** The export services narrowed to the mounted ones streaming actually reads. */
export interface SessionLogExportReady {
  readonly sessionQuery: SessionQueryEngine
  readonly sessionPersistence: SessionPersistence
  readonly attachments: AttachmentStore
  readonly sessions: SessionStore | undefined
}

/**
 * Resolve the persistence, session-query, and attachment services a log export needs.
 * @param ctx - the composed host context.
 * @returns the export services (absent when the deployment does not mount them).
 */
export function sessionLogExportDeps(ctx: Context): SessionLogExportDeps {
  return {
    sessionQuery: ctx.get('sessionQuery'),
    sessionPersistence: ctx.get('sessionPersistence'),
    attachments: ctx.get('attachments'),
    sessions: ctx.get('sessions'),
  }
}

/**
 * Flush one currently live session through the store's authoritative durability
 * barrier immediately before its logical log is read. A cold or absent id has
 * no in-memory work to flush. A live session without a durability listener
 * rejects rather than exporting a potentially stale persisted log.
 * @param deps - export services, including the optional live-session store.
 * @param id - the session whose artifact is about to be read.
 * @param signal - optional cancellation observed around the flush barrier.
 */
export async function flushLiveSessionLog(
  deps: Pick<SessionLogExportDeps, 'sessions'>,
  id: SessionId,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const sessions = deps.sessions
  if (sessions === undefined) return
  const session = sessions.get(id)
  if (session === undefined) return
  if (!await sessions.flush(session)) {
    throw new Error(`session "${id}" has no durability listener for export`)
  }
  signal?.throwIfAborted()
}

/** One exported file: a serialized session log or one referenced attachment object. */
export type SessionLogZipEntry =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly data: Uint8Array }
  | { readonly path: string; readonly chunks: AsyncIterable<Uint8Array> }

/** The current generation's canonical base filename for every exported session log. */
export const SESSION_LOG_FILENAME = sessionFormatLogFilename(SESSION_FORMAT_VERSION)

/**
 * Serialize one session's logical log as canonical JSONL text: the header
 * line, then one line per event, with a trailing newline.
 * @param header - the session's immutable header.
 * @param events - the validated committed events in seq order.
 * @returns the JSONL text.
 */
export function serializeSessionLog(
  header: SessionHeader,
  events: readonly SessionEvent[],
): string {
  // Match the current v3 physical header. The inherited cut is already
  // represented by the tagged session/end-seed event in `events`;
  // `delegationDepth` is required on disk, so an omitted top-level depth is 0.
  /* jscpd:ignore-start -- deliberately mirrors the JSONL backend's
     `toHeaderLine`: the exported text is the canonical v3 physical header
     line, and this backend-agnostic package must not depend on one backend
     implementation. */
  const lines = [JSON.stringify({
    type: 'session',
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    ...header.parentSession !== undefined ? { parentSession: header.parentSession } : {},
    ...header.importLineage !== undefined ? { importLineage: header.importLineage } : {},
    isSeeded: header.isSeeded,
    ...header.origin !== undefined ? { origin: header.origin } : {},
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {},
  })]
  /* jscpd:ignore-end */
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * Read one session's complete logical log through a read handle and serialize
 * it. The read observes the committed log only — persistence never returns a
 * torn tail — and a handle read after a resolved flush observes at least the
 * flushed prefix.
 * @param persistence - the mounted persistence backend.
 * @param id - the session to read.
 * @param signal - optional cancellation forwarded to the open and read.
 * @returns the serialized JSONL text, or `undefined` when the session does not exist.
 */
export async function readSessionLogText(
  persistence: SessionPersistence,
  id: SessionId,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const options = signal === undefined ? {} : { signal }
  let handle: SessionHandle
  try {
    handle = await persistence.open(id, 'read', options)
  } catch (error) {
    // Absence is `open`'s decision; every other failure (corruption,
    // unsupported format, I/O, cancellation) stays fail-loud.
    if (error instanceof SessionPersistenceNotFoundError) return undefined
    throw error
  }
  try {
    const events = await handle.read(0, undefined, options)
    return serializeSessionLog(handle.header, events)
  } finally {
    await handle.close()
  }
}

/** Zip extension for each accepted raster media type. */
const MEDIA_TYPE_EXTENSIONS: Record<ImageAttachmentRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Archive path for an image; the content-address prefix is not a filename component.
 * @param attachmentId - unchanged durable attachment identity.
 * @param mediaType - one supported raster media type.
 * @returns relative media path without the `sha256:` namespace prefix.
 */
export function mediaEntryPath(attachmentId: string, mediaType: ImageAttachmentRef['mediaType']): string {
  return `media/${attachmentId.replace(/^sha256:/u, '')}.${MEDIA_TYPE_EXTENSIONS[mediaType]}`
}

/** Archive path that preserves one stored file reference's digest and safe name.
 * @param attachmentId - content-addressed file identity.
 * @param name - original stored or portable file name.
 * @returns exact ZIP entry path for this digest and name.
 */
export function fileEntryPath(attachmentId: string, name: string): string {
  const digest = attachmentId.replace(/^sha256:/u, '')
  const segment = name.replace(/[\\/\u0000-\u001f\u007f]/gu, '_')
  const safeName = segment === '.' || segment === '..' || segment === '' ? 'file' : segment
  return `files/${digest.slice(0, 2)}/${digest}/${safeName}`
}

/**
 * Collect every attachment reference inside one content array, descending into
 * nested tool results the way the live attachment route does.
 * @param content - an event content array (or nested tool-result content).
 * @param images - image dedupe map keyed by attachment id.
 * @param files - file dedupe map keyed by attachment id and stored name.
 */
function collectAttachmentRefs(
  content: unknown,
  images: Map<string, ImageAttachmentRef>,
  files: Map<string, FileAttachmentRef>,
): void {
  if (!Array.isArray(content)) return
  const pending: unknown[] = []
  for (const item of content) pending.push(item)
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      const prior = images.get(String(ref.attachmentId))
      if (prior !== undefined && (prior.bytes !== ref.bytes || prior.mediaType !== ref.mediaType
        || prior.width !== ref.width || prior.height !== ref.height)) {
        throw new Error('session archive: conflicting image attachment metadata')
      }
      images.set(String(ref.attachmentId), ref)
    }
    if (block.type === 'file' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as FileAttachmentRef
      const key = `${String(ref.attachmentId)}\u0000${ref.name}`
      const prior = files.get(key)
      if (prior !== undefined && prior.bytes !== ref.bytes) {
        throw new Error('session archive: conflicting file attachment metadata')
      }
      files.set(key, ref)
    }
    if (Array.isArray(block.content)) {
      for (const item of block.content) pending.push(item)
    }
  }
}

/**
 * Collect every attachment reference one session event carries, across the same
 * carriers the live attachment route scans (direct content, message content,
 * inserted messages, and completed blocks in embedded Assistant streams).
 * @param event - one parsed JSONL event object.
 * @param images - image dedupe map keyed by attachment id.
 * @param files - file dedupe map keyed by attachment id and stored name.
 */
function collectEventAttachmentRefs(
  event: unknown,
  images: Map<string, ImageAttachmentRef>,
  files: Map<string, FileAttachmentRef>,
): void {
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return
  const carrier = data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    stream?: Array<{ type?: unknown; chunk?: { type?: unknown; block?: unknown } }>
  }
  collectAttachmentRefs(carrier.content, images, files)
  if (carrier.message !== undefined) collectAttachmentRefs(carrier.message.content, images, files)
  if (carrier.inserted !== undefined) {
    for (const message of carrier.inserted) collectAttachmentRefs(message.content, images, files)
  }
  if (carrier.stream !== undefined) {
    for (const record of carrier.stream) {
      if (record.type === 'chunk' && record.chunk?.type === 'block-end') {
        collectAttachmentRefs([record.chunk.block], images, files)
      }
    }
  }
}

/**
 * Collect the distinct attachment references one stored artifact text names.
 * Lines that fail to parse cannot reference attachments and are skipped (the
 * artifact text itself is exported verbatim regardless).
 * @param content - the stored artifact text.
 * @param images - archive-wide image references, checked before deduplication.
 * @param files - archive-wide file references, checked before deduplication.
 */
function collectArtifactAttachmentRefs(
  content: string,
  images: Map<string, ImageAttachmentRef>,
  files: Map<string, FileAttachmentRef>,
): void {
  for (const line of content.split('\n')) {
    if (line === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    collectEventAttachmentRefs(event, images, files)
  }
}

/** Collect attachment references from the same durable carriers used by export.
 * Reject conflicting byte or image metadata before deduplicating references.
 * @param events - decoded events from complete validated Session logs.
 * @returns image and file references, including nested tool-result content.
 */
export function attachmentRefsInEvents(events: Iterable<unknown>): {
  readonly images: Map<string, ImageAttachmentRef>
  readonly files: Map<string, FileAttachmentRef>
} {
  const images = new Map<string, ImageAttachmentRef>()
  const files = new Map<string, FileAttachmentRef>()
  for (const event of events) collectEventAttachmentRefs(event, images, files)
  return { images, files }
}

const AUDIT_PAYLOAD_FIELDS = [
  'request', 'chunk', 'result', 'arguments', 'inputHistory', 'prompt',
  'effectiveHistory', 'details', 'config', 'response', 'snapshot',
] as const
const AUDIT_SHA256 = /^[0-9a-f]{64}$/

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Verify Codex ordering and require each artifact reference to follow its Session receipt.
 * @param events - one complete Session's decoded events, in durable order.
 * @returns referenced artifacts and checkpoints with their preceding audit facts.
 */
export function auditArtifactRefsInEvents(events: Iterable<unknown>): {
  readonly refs: Map<string, FileAttachmentRef>
  readonly checkpoints: readonly {
    readonly fact: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>
    readonly preceding: readonly CodexAuditEventV1[]
  }[]
} {
  const receipts = new Map<string, {
    readonly bytes: number
    readonly mediaType: string
    readonly name: string
    readonly threadId: string
  }>()
  const referenced = new Map<string, FileAttachmentRef>()
  const facts: CodexAuditEventV1[] = []
  const eventIds = new Set<string>()
  const checkpoints: { fact: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>
    preceding: readonly CodexAuditEventV1[] }[] = []
  let threadId: string | undefined
  let pending: Extract<CodexAuditEventV1, { readonly kind: 'compaction/pending' }> | undefined
  for (const parsed of events) {
    const event = object(parsed)
    if (event?.type === 'codex/artifact-v1') {
      const receipt = object(event.data)
      const sha256 = receipt?.sha256
      if (receipt?.version !== 1 || typeof receipt.threadId !== 'string' || receipt.threadId === ''
        || typeof sha256 !== 'string' || !AUDIT_SHA256.test(sha256)
        || typeof receipt.bytes !== 'number' || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0
        || typeof receipt.mediaType !== 'string' || typeof receipt.name !== 'string'
        || receipt.name !== `dsh-audit-${sha256}.blob` || receipts.has(sha256)) {
        throw new Error('session export: invalid or duplicate Codex audit artifact receipt')
      }
      receipts.set(sha256, { bytes: receipt.bytes, mediaType: receipt.mediaType,
        name: receipt.name, threadId: receipt.threadId })
      continue
    }
    if (event?.type !== 'codex/audit-v1') continue
    const fact = parseCodexAuditEventV1(event.data)
    if (fact.sequence !== facts.length + 1 || eventIds.has(fact.eventId)
      || (threadId !== undefined && fact.threadId !== threadId)) {
      throw new Error('session export: Codex audit sequence, event ID, or thread is inconsistent')
    }
    if (pending !== undefined) {
      if ((fact.kind !== 'compaction/installed' && fact.kind !== 'compaction/aborted')
        || fact.compactionId !== pending.compactionId
        || !isDeepStrictEqual(fact.effectiveHistory, pending.effectiveHistory)
        || (fact.kind === 'compaction/aborted' && pending.priorRolloutSha256 === undefined)) {
        throw new Error(`session export: Codex compaction ${pending.compactionId} is incomplete`)
      }
      pending = undefined
    } else if (fact.kind === 'compaction/installed' || fact.kind === 'compaction/aborted') {
      throw new Error(`session export: Codex compaction ${fact.compactionId} has no pending checkpoint`)
    } else if (fact.kind === 'compaction/pending') {
      pending = fact
    }
    threadId = fact.threadId
    eventIds.add(fact.eventId)
    if (fact.kind === 'checkpoint') checkpoints.push({ fact, preceding: [...facts] })
    facts.push(fact)
    for (const field of AUDIT_PAYLOAD_FIELDS) {
      const payload = object((fact as unknown as Record<string, unknown>)[field])
      if (payload?.kind !== 'artifact') continue
      const sha256 = payload.sha256
      const bytes = payload.bytes
      const mediaType = payload.mediaType
      if (typeof sha256 !== 'string' || !AUDIT_SHA256.test(sha256)
        || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0
        || typeof mediaType !== 'string') {
        throw new Error('session export: invalid Codex audit artifact reference')
      }
      const receipt = receipts.get(sha256)
      if (receipt === undefined || receipt.bytes !== bytes || receipt.mediaType !== mediaType
        || receipt.threadId !== fact.threadId) {
        throw new Error(`session export: Codex audit artifact ${sha256} has no matching Session receipt`)
      }
      referenced.set(sha256, {
        attachmentId: AttachmentId(`sha256:${sha256}`), name: receipt.name, bytes,
      })
    }
  }
  if (pending !== undefined) throw new Error(`session export: Codex compaction ${pending.compactionId} is incomplete`)
  return { refs: referenced, checkpoints }
}

function auditArtifactRefsInLog(content: string): ReturnType<typeof auditArtifactRefsInEvents> {
  const events = function* () {
    let firstLine = true
    for (const line of content.split('\n')) {
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (cause) {
        // Direct ZIP chunking callers may supply plain text instead of a Session log.
        if (firstLine) return
        throw new Error('session export: invalid Session log while scanning Codex audit artifacts', { cause })
      }
      firstLine = false
      yield parsed
    }
  }
  return auditArtifactRefsInEvents(events())
}

async function readAuditArtifactJson(
  attachments: AttachmentStore,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of verifiedAuditArtifactChunks(attachments, ref, signal)) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (cause) {
    throw new Error('session export: Codex audit artifact contains invalid JSON', { cause })
  }
}

/** Verify exact bytes while streaming; an incomplete or altered blob errors the whole ZIP. */
async function* verifiedAuditArtifactChunks(
  attachments: AttachmentStore,
  ref: FileAttachmentRef,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const sha256 = String(ref.attachmentId).slice('sha256:'.length)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of attachments.readFileStream(ref, signal)) {
    signal?.throwIfAborted()
    hash.update(chunk)
    bytes += chunk.byteLength
    if (!Number.isSafeInteger(bytes) || bytes > ref.bytes) {
      throw new Error(`session export: Codex audit artifact ${sha256} exceeds its receipt size`)
    }
    yield chunk
  }
  if (bytes !== ref.bytes || hash.digest('hex') !== sha256) {
    throw new Error(`session export: Codex audit artifact ${sha256} hash or size differs`)
  }
}

/**
 * One safe zip path segment from an untrusted session id. Session ids are
 * host-controlled, but the brand allows any non-empty string, so `../`, dot
 * segments, and separator characters are neutralized before they can shape
 * archive entries. Distinct ids may collapse onto one segment (id collision
 * is impossible for the host-minted UUIDs, so no uniqueness suffix is kept).
 * @param id - the raw session id.
 * @returns a filesystem-safe single path segment.
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * The export archive filename for one root session.
 * @param sessionId - the root session id (sanitized to one safe path segment).
 * @returns the attachment filename for the session's export archive.
 */
export function sessionLogZipFilename(sessionId: string): string {
  return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`
}

/**
 * Yield the export entries in zip order: the preloaded root log first, then
 * every subagent descendant in lineage order (each flushed when live, read
 * through a persistence read handle right before it is yielded, and dropped
 * after the consumer moves on), then every distinct attachment referenced by
 * the included logs. Images are read and verified as bounded stored objects;
 * generic files and Codex audit blobs remain streamed through the ZIP writer. The host holds at most
 * one descendant log, one image, and one file chunk beyond the root.
 * @param deps - the mounted export services (the caller answered 500 before this runs).
 * @param rootContent - the already-serialized root log (read by the caller so
 * the missing-session path can answer cleanly before streaming starts).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param signal - optional cancellation forwarded to lineage, persistence, and attachment reads.
 * @returns the export entries in zip order.
 */
export async function* sessionLogZipEntries(
  deps: SessionLogExportReady,
  rootContent: string,
  sessionId: SessionId,
  includeDescendants: boolean,
  signal?: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  const media = new Map<string, ImageAttachmentRef>()
  const files = new Map<string, FileAttachmentRef>()
  const auditArtifacts = new Map<string, FileAttachmentRef>()
  const checkpoints: { readonly fact: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>
    readonly preceding: readonly CodexAuditEventV1[] }[] = []
  const rememberAttachments = (content: string): void => {
    collectArtifactAttachmentRefs(content, media, files)
    const audit = auditArtifactRefsInLog(content)
    checkpoints.push(...audit.checkpoints)
    for (const [sha256, ref] of audit.refs) {
      const prior = auditArtifacts.get(sha256)
      if (prior !== undefined && (prior.bytes !== ref.bytes || prior.name !== ref.name)) {
        throw new Error(`session export: conflicting Codex audit artifact ${sha256}`)
      }
      auditArtifacts.set(sha256, ref)
    }
  }
  rememberAttachments(rootContent)
  yield { path: SESSION_LOG_FILENAME, content: rootContent }
  if (includeDescendants) {
    const seen = new Set<SessionId>([sessionId])
    const collect = async function* (
      nodes: readonly SessionLineageNode[],
    ): AsyncGenerator<SessionLogZipEntry> {
      for (const node of nodes) {
        signal?.throwIfAborted()
        const id = node.session.header.id
        if (seen.has(id)) continue
        seen.add(id)
        await flushLiveSessionLog(deps, id, signal)
        const content = await readSessionLogText(deps.sessionPersistence, id, signal)
        signal?.throwIfAborted()
        if (content === undefined) {
          throw new Error(`subagent "${id}" has no stored log`)
        }
        rememberAttachments(content)
        yield {
          path: `subagents/${safeSessionIdSegment(id)}/${SESSION_LOG_FILENAME}`,
          content,
        }
        yield* collect(node.descendants)
      }
    }
    const lineage = await deps.sessionQuery.traceSession(sessionId, signal)
    signal?.throwIfAborted()
    yield* collect(lineage.descendants)
  }
  for (const ref of media.values()) {
    signal?.throwIfAborted()
    const stored = await deps.attachments.readImage(ref, signal)
    signal?.throwIfAborted()
    yield { path: mediaEntryPath(String(ref.attachmentId), ref.mediaType), data: stored.data }
  }
  for (const ref of files.values()) {
    signal?.throwIfAborted()
    yield {
      path: fileEntryPath(String(ref.attachmentId), ref.name),
      chunks: deps.attachments.readFileStream(ref, signal),
    }
  }
  for (const { fact, preceding } of checkpoints) {
    const resolve = async (payload: CodexAuditPayloadV1): Promise<unknown> => {
      if (payload.kind === 'inline') return payload.value
      const ref = auditArtifacts.get(payload.sha256)
      if (ref === undefined || ref.bytes !== payload.bytes) {
        throw new Error(`session export: checkpoint artifact ${payload.sha256} is missing`)
      }
      return readAuditArtifactJson(deps.attachments, ref, signal)
    }
    try {
      const ref = auditArtifacts.get(fact.snapshot.sha256)
      if (ref === undefined) throw new Error('checkpoint artifact is missing')
      await verifyCodexCheckpointArtifactV2(deps.attachments.readFileStream(ref, signal),
        { sha256: fact.snapshot.sha256, bytes: fact.snapshot.bytes }, fact, preceding, resolve)
    } catch (cause) {
      throw new Error(`session export: invalid Codex checkpoint ${fact.checkpointId}`, { cause })
    }
  }
  for (const [sha256, ref] of auditArtifacts) {
    signal?.throwIfAborted()
    yield {
      path: `audit/${sha256}.blob`,
      chunks: verifiedAuditArtifactChunks(deps.attachments, ref, signal),
    }
  }
}

/** How many code units of Session-log text one zip push carries (bounded encode memory). */
const PUSH_CHUNK_CODE_UNITS = 1 << 16

/** How many bytes of media one zip push carries (bounded memory; images are already size-capped). */
const PUSH_CHUNK_BYTES = 1 << 16

/** Byte capacity retained by the response stream before ZIP production waits for pull. */
const RESPONSE_HIGH_WATER_MARK_BYTES = 1 << 16

/** One producer waiter released only when ReadableStream pull restores capacity. */
class ResponseCapacityGate {
  private releasePending: (() => void) | undefined

  /**
   * Wait until the response queue has positive byte capacity or cancellation wins.
   * @param controller - response controller whose desired size owns capacity.
   * @param signal - combined request/consumer cancellation.
   */
  async wait(
    controller: ReadableStreamDefaultController<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    if (controller.desiredSize === null || controller.desiredSize > 0) return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        this.releasePending = undefined
        signal.removeEventListener('abort', release)
        resolve()
      }
      this.releasePending = release
      signal.addEventListener('abort', release, { once: true })
    })
    signal.throwIfAborted()
  }

  /** Release the current producer waiter after a consumer pull. */
  pulled(): void {
    this.releasePending?.()
  }
}

/**
 * Push one media object's bytes into a deflate stream in bounded chunks,
 * waiting for consumer capacity between chunks like the artifact path does.
 * @param deflate - the zip entry's deflate stream.
 * @param data - the stored image bytes.
 * @param controller - response queue controller.
 * @param capacity - pull-driven response-capacity gate.
 * @param signal - cancellation; throws when aborted.
 */
async function pushBinaryChunks(
  deflate: ZipDeflate,
  data: Uint8Array,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0
  do {
    signal.throwIfAborted()
    const end = Math.min(offset + PUSH_CHUNK_BYTES, data.byteLength)
    const finalChunk = end >= data.byteLength
    deflate.push(data.subarray(offset, end), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (offset < data.byteLength)
}

/** Push one streamed file entry without retaining its complete byte sequence. */
async function pushStreamChunks(
  deflate: ZipDeflate,
  chunks: AsyncIterable<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  for await (const chunk of chunks) {
    signal.throwIfAborted()
    if (chunk.byteLength === 0) continue
    deflate.push(chunk, false)
    await capacity.wait(controller, signal)
  }
  signal.throwIfAborted()
  deflate.push(new Uint8Array(), true)
  await capacity.wait(controller, signal)
}

/**
 * Push one artifact's text into a deflate stream in bounded chunks, never
 * splitting a surrogate pair across a chunk boundary (a lone high surrogate
 * re-encodes as U+FFFD and would silently corrupt the exported artifact).
 * @param deflate - the zip entry's deflate stream.
 * @param content - the canonical Session-log text.
 * @param controller - response queue controller.
 * @param capacity - pull-driven response-capacity gate.
 * @param signal - cancellation; throws when aborted.
 */
async function pushArtifactChunks(
  deflate: ZipDeflate,
  content: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder()
  let offset = 0
  let finalChunk: boolean
  do {
    signal.throwIfAborted()
    let end = Math.min(offset + PUSH_CHUNK_CODE_UNITS, content.length)
    if (end < content.length && end - offset > 1) {
      // Back off one code unit when the boundary lands inside a surrogate
      // pair: the pair then starts the next chunk whole.
      const last = content.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
    }
    finalChunk = end >= content.length
    deflate.push(encoder.encode(content.slice(offset, end)), finalChunk)
    offset = end
    await capacity.wait(controller, signal)
  } while (!finalChunk)
}

/**
 * Stream one session-log ZIP as a WHATWG ReadableStream. The root log is read
 * and serialized by the caller before this is called (a missing root or
 * missing services answer cleanly before any byte is produced); each entry is
 * then encoded and deflated in bounded chunks as it is produced, so the
 * archive bytes arrive incrementally. A descendant that fails to read errors
 * the stream (fail-loud, never silent under-export).
 * @param deps - the mounted export services (the caller answered 500 before this runs).
 * @param rootContent - the already-serialized root log (first zip entry).
 * @param sessionId - the root session id.
 * @param includeDescendants - whether to include every subagent descendant.
 * @param compressionLevel - validated fflate DEFLATE level for every ZIP entry.
 * @param signal - request cancellation combined with response-consumer cancellation.
 * @param entries - optional portable entry source; defaults to log-only entries.
 * @returns the zip byte stream.
 */
export function streamSessionLogZip(
  deps: SessionLogExportReady,
  rootContent: string,
  sessionId: SessionId,
  includeDescendants: boolean,
  compressionLevel: SessionLogCompressionLevel,
  signal: AbortSignal,
  entries?: (signal: AbortSignal) => AsyncIterable<SessionLogZipEntry>,
): ReadableStream<Uint8Array> {
  const consumerAbort = new AbortController()
  const producerSignal = AbortSignal.any([signal, consumerAbort.signal])
  let zip: Zip | undefined
  let zipTerminated = false
  const capacity = new ResponseCapacityGate()
  const terminateZip = (): void => {
    if (zip === undefined || zipTerminated) return
    zipTerminated = true
    zip.terminate()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // fflate invokes the callback synchronously per compressed chunk, so a
      // single push can enqueue ahead of a slow consumer; the capacity gate
      // waits for pull between pushes once the byte queue is full, bounding
      // accumulation to the queue high-water mark plus one synchronous push.
      const archive = new Zip((error, data, final) => {
        /* v8 ignore next 3 -- fflate reports only internal zip failures, unreachable for valid inputs */
        if (error) {
          controller.error(error)
          return
        }
        /* v8 ignore next -- fflate may emit empty chunks; not controllable from tests */
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      zip = archive
      void (async () => {
        try {
          for await (const entry of entries?.(producerSignal)
            ?? sessionLogZipEntries(deps, rootContent, sessionId, includeDescendants, producerSignal)) {
            const deflate = new ZipDeflate(entry.path, { level: compressionLevel })
            archive.add(deflate)
            if ('content' in entry) {
              await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal)
            } else if ('data' in entry) {
              await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal)
            } else {
              await pushStreamChunks(deflate, entry.chunks, controller, capacity, producerSignal)
            }
          }
          archive.end()
        } catch (error) {
          // A mid-stream failure (missing descendant, cancellation, read
          // error) must fail the download rather than ship a truncated archive.
          /* v8 ignore next -- typed backends reject with Error, and DOMException is one in Node */
          terminateZip()
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    },
    pull() {
      capacity.pulled()
    },
    cancel(reason) {
      consumerAbort.abort(
        reason instanceof Error ? reason : new Error('session log export stream cancelled'),
      )
      terminateZip()
    },
  }, {
    highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
    size: chunk => chunk.byteLength,
  })
}
