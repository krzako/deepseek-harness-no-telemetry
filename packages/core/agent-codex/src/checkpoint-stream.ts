/** Byte-verified, bounded-memory admission of one fork checkpoint artifact. */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, open, readdir, rm, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parser } from 'stream-json'
import { pick } from 'stream-json/filters/pick.js'
import { streamArray } from 'stream-json/streamers/stream-array.js'
import { streamValues } from 'stream-json/streamers/stream-values.js'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CodexAuditEventV1 } from './audit-contract.ts'
import { codexJsonArraySha256, codexJsonSha256, verifyCodexCheckpointAuditSummaryV2,
  type CodexCheckpointPayloadResolver, type CodexCheckpointSummaryV2 } from './context-snapshot.ts'

const FIELDS = [
  'version', 'hashAlgorithm', 'runtimeRevision', 'historyVersion', 'effectiveHistory',
  'effectiveHistorySha256', 'retainedContext', 'compactions', 'rollout', 'rolloutSha256',
  'contextConfig',
] as const
const PROCESS_TOKEN = randomBytes(8).toString('hex')
const CHECKPOINT_DIRECTORY = /^dsh-checkpoint-([1-9][0-9]*)-([a-f0-9]{16})-[A-Za-z0-9]{6}$/
let startupCleanup: Promise<number> | undefined

/** Derive a private-directory prefix distinct across restarts, including a reused PID 1.
 * @returns the owned temporary directory prefix.
 */
export function codexCheckpointTempPrefix(): string {
  return `dsh-checkpoint-${process.pid}-${PROCESS_TOKEN}-`
}

/**
 * Remove only inactive, owned checkpoint directories with recognized contents.
 * @param root Temporary directory to scan.
 * @param alive Process-liveness check; permission errors count as live by default.
 * @returns Number of directories removed.
 */
export async function cleanupOrphanedCodexCheckpoints(
  root = tmpdir(),
  alive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  },
): Promise<number> {
  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const match = CHECKPOINT_DIRECTORY.exec(entry.name)
    if (match === null || !entry.isDirectory()) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid)
      || (pid === process.pid && match[2] === PROCESS_TOKEN)
      || (pid !== process.pid && alive(pid))) continue
    const path = join(root, entry.name)
    try {
      const directory = await lstat(path)
      if (!directory.isDirectory() || directory.isSymbolicLink()
        || (process.getuid !== undefined && directory.uid !== process.getuid())) continue
      const contents = await readdir(path)
      if (contents.some(name => name !== 'snapshot.json')) continue
      if (contents.includes('snapshot.json')) {
        const snapshot = join(path, 'snapshot.json')
        const file = await lstat(snapshot)
        if (!file.isFile() || file.isSymbolicLink()) continue
        await unlink(snapshot)
      }
      await rmdir(path)
      removed++
    } catch (cause) {
      if (['ENOENT', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code ?? '')) continue
      throw cause
    }
  }
  return removed
}

/** Reuse one restart sweep across concurrent Codex Session starts.
 * @returns the cleanup result shared by callers.
 */
export function ensureCodexCheckpointCleanup(): Promise<number> {
  return startupCleanup ??= cleanupOrphanedCodexCheckpoints()
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

async function topLevelKeys(path: string): Promise<Set<string>> {
  const keys = new Set<string>()
  let depth = 0
  let rootObject = false
  for await (const token of createReadStream(path).pipe(parser.asStream({
    packKeys: true, streamKeys: false, packStrings: false, streamStrings: true,
  }))) {
    const item = token as { name: string; value?: unknown }
    if (item.name === 'startObject' || item.name === 'startArray') {
      if (depth === 0 && item.name === 'startObject') rootObject = true
      depth++
    } else if (item.name === 'endObject' || item.name === 'endArray') depth--
    else if (item.name === 'keyValue' && depth === 1) {
      if (typeof item.value !== 'string' || keys.has(item.value)) {
        throw new Error('agent-codex: duplicate or invalid checkpoint field')
      }
      keys.add(item.value)
    }
  }
  if (!rootObject || keys.size !== FIELDS.length || FIELDS.some(field => !keys.has(field))) {
    throw new Error('agent-codex: invalid V2 checkpoint fields')
  }
  return keys
}

async function field(path: string, name: string): Promise<unknown> {
  let found = false
  let value: unknown
  for await (const item of createReadStream(path).pipe(parser.asStream())
    .pipe(pick.asStream({ filter: name })).pipe(streamValues.asStream())) {
    if (found) throw new Error(`agent-codex: duplicate checkpoint ${name}`)
    found = true
    value = (item as { value: unknown }).value
  }
  if (!found) throw new Error(`agent-codex: missing checkpoint ${name}`)
  return value
}

async function* arrayItems(path: string, name: string): AsyncGenerator<JsonValue> {
  for await (const item of createReadStream(path).pipe(parser.asStream())
    .pipe(pick.asStream({ filter: name })).pipe(streamArray.asStream())) {
    const value = (item as { value: unknown }).value
    if (!isJsonValue(value)) throw new Error(`agent-codex: non-JSON ${name} item`)
    yield value as JsonValue
  }
}

async function arrayCount(path: string, name: string): Promise<number> {
  let count = 0
  for await (const _item of arrayItems(path, name)) count++
  return count
}

interface CompactionDigest {
  readonly id: string
  readonly summary: string
  readonly replacementHistorySha256: string
  readonly responseId: string | null
  readonly windowId: string | null
}

function compactionDigest(value: JsonValue): CompactionDigest {
  if (!record(value) || typeof value.id !== 'string' || value.id === ''
    || Object.keys(value).length !== 5
    || ['id', 'summary', 'replacementHistory', 'responseId', 'windowId'].some(key => !Object.hasOwn(value, key))
    || typeof value.summary !== 'string' || !Array.isArray(value.replacementHistory)
    || value.replacementHistory.length === 0 || !value.replacementHistory.every(isJsonValue)
    || (value.responseId !== null && typeof value.responseId !== 'string')
    || (value.windowId !== null && typeof value.windowId !== 'string')) {
    throw new Error('agent-codex: invalid streamed compaction')
  }
  const last = value.replacementHistory.at(-1)
  if (!record(last) || !record(last.metadata) || last.metadata.dsh_compaction_id !== value.id) {
    throw new Error('agent-codex: streamed compaction identity differs from replacement history')
  }
  return {
    id: value.id,
    summary: value.summary,
    replacementHistorySha256: codexJsonSha256(value.replacementHistory),
    responseId: value.responseId,
    windowId: value.windowId,
  }
}

function rolloutCompactionDigest(value: JsonValue): CompactionDigest | undefined {
  if (!record(value) || value.type !== 'compacted') return undefined
  const payload = value.payload
  if (!record(payload) || typeof payload.message !== 'string'
    || !Array.isArray(payload.replacement_history) || !payload.replacement_history.every(isJsonValue)) {
    throw new Error('agent-codex: invalid streamed rollout compaction')
  }
  const history = payload.replacement_history
  const metadata = payload.replacement_history_metadata
  if ((payload.compaction_response_id !== null && typeof payload.compaction_response_id !== 'string')
    || (payload.window_id !== undefined && payload.window_id !== null
      && typeof payload.window_id !== 'string')) {
    throw new Error('agent-codex: invalid rollout compaction provenance')
  }
  if (metadata !== undefined && (!Array.isArray(metadata) || metadata.length !== history.length
    || !metadata.every(isJsonValue))) throw new Error('agent-codex: invalid rollout compaction metadata')
  const replacementHistory = history.map((item, index) => ({
    item,
    ...(metadata === undefined ? {} : { metadata: metadata[index] }),
  }))
  const last = replacementHistory.at(-1)
  if (!record(last?.metadata) || typeof last.metadata.dsh_compaction_id !== 'string') {
    throw new Error('agent-codex: rollout compaction has no durable identity')
  }
  return {
    id: last.metadata.dsh_compaction_id,
    summary: payload.message,
    replacementHistorySha256: codexJsonSha256(replacementHistory),
    responseId: typeof payload.compaction_response_id === 'string' ? payload.compaction_response_id : null,
    windowId: typeof payload.window_id === 'string' ? payload.window_id : null,
  }
}

async function validateSnapshotFile(
  path: string,
  checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>,
  preceding: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
): Promise<string> {
  await topLevelKeys(path)
  const runtimeRevision = await field(path, 'runtimeRevision')
  if (await field(path, 'version') !== 2 || await field(path, 'hashAlgorithm') !== 'dsh-json-v1'
    || typeof runtimeRevision !== 'string' || runtimeRevision === '') {
    throw new Error('agent-codex: unsupported streamed checkpoint version')
  }
  const historyVersion = await field(path, 'historyVersion')
  const effectiveHistorySha256 = await field(path, 'effectiveHistorySha256')
  const rolloutSha256 = await field(path, 'rolloutSha256')
  const retainedContext = await field(path, 'retainedContext')
  const contextConfig = await field(path, 'contextConfig')
  if (!Number.isSafeInteger(historyVersion) || (historyVersion as number) < 0
    || !sha256(effectiveHistorySha256) || !sha256(rolloutSha256)
    || !record(retainedContext) || !isJsonValue(retainedContext)
    || !record(contextConfig) || contextConfig.schemaVersion !== 1 || !isJsonValue(contextConfig)) {
    throw new Error('agent-codex: invalid streamed checkpoint metadata')
  }
  const historyCount = await arrayCount(path, 'effectiveHistory')
  if (await codexJsonArraySha256(historyCount, arrayItems(path, 'effectiveHistory')) !== effectiveHistorySha256) {
    throw new Error('agent-codex: streamed effective history hash differs')
  }
  const compactions: CompactionDigest[] = []
  const ids = new Set<string>()
  for await (const item of arrayItems(path, 'compactions')) {
    const compacted = compactionDigest(item)
    if (ids.has(compacted.id)) throw new Error('agent-codex: duplicate streamed compaction identity')
    ids.add(compacted.id)
    compactions.push(compacted)
  }
  const rolloutCount = await arrayCount(path, 'rollout')
  let compactionIndex = 0
  const rolloutItems = async function* (): AsyncGenerator<JsonValue> {
    for await (const item of arrayItems(path, 'rollout')) {
      const compacted = rolloutCompactionDigest(item)
      if (compacted !== undefined) {
        const expected = compactions[compactionIndex++]
        if (expected === undefined || JSON.stringify(expected) !== JSON.stringify(compacted)) {
          throw new Error('agent-codex: rollout compaction differs from checkpoint chain')
        }
      }
      yield item
    }
  }
  if (await codexJsonArraySha256(rolloutCount, rolloutItems()) !== rolloutSha256
    || compactionIndex !== compactions.length) {
    throw new Error('agent-codex: streamed rollout hash or compaction chain differs')
  }
  const summary: CodexCheckpointSummaryV2 = {
    effectiveHistorySha256,
    contextConfig: contextConfig as JsonValue,
    compactions: compactions.map(({ id, replacementHistorySha256 }) => ({ id, replacementHistorySha256 })),
  }
  await verifyCodexCheckpointAuditSummaryV2(summary, checkpoint, preceding, resolve)
  return runtimeRevision
}

/** Bounded-memory reads from a validated temporary V2 checkpoint. */
export interface VerifiedCodexCheckpointRead {
  readonly runtimeRevision: string
  /** Read one validated small JSON field while the private spool exists. */
  field(name: 'retainedContext' | 'contextConfig'): Promise<JsonValue>
  /** Iterate one large JSON array without retaining every element. */
  array(name: 'effectiveHistory' | 'compactions' | 'rollout'): AsyncIterable<JsonValue>
}

async function openVerifiedCodexCheckpointArtifactV2(
  chunks: AsyncIterable<Uint8Array>,
  receipt: { readonly sha256: string; readonly bytes: number },
  checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>,
  preceding: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
): Promise<{ readonly read: VerifiedCodexCheckpointRead; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), codexCheckpointTempPrefix()))
  const path = join(directory, 'snapshot.json')
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, 'wx', 0o600)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of chunks) {
      bytes += chunk.byteLength
      if (!Number.isSafeInteger(bytes) || bytes > receipt.bytes) {
        throw new Error('agent-codex: checkpoint exceeded its artifact receipt size')
      }
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset, chunk.byteLength - offset)
        if (written.bytesWritten === 0) throw new Error('agent-codex: zero-length checkpoint write')
        offset += written.bytesWritten
      }
    }
    await file.sync()
    await file.close()
    file = undefined
    if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256) {
      throw new Error('agent-codex: checkpoint artifact hash or size differs')
    }
    const runtimeRevision = await validateSnapshotFile(path, checkpoint, preceding, resolve)
    return { read: { runtimeRevision,
      async field(name) {
        const value = await field(path, name)
        if (!isJsonValue(value)) throw new Error(`agent-codex: invalid checkpoint ${name}`)
        return value as JsonValue
      },
      array(name) { return arrayItems(path, name) },
    }, close: () => rm(directory, { recursive: true, force: true }) }
  } catch (cause) {
    await file?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
}

/** Verify outer receipt while spooling, then allow scoped reads of V2 fields.
 * @param chunks - streamed checkpoint bytes from the session-owned artifact.
 * @param receipt - expected byte count and SHA-256 of those bytes.
 * @param checkpoint - audit fact binding the checkpoint to its history hash.
 * @param preceding - ordered facts committed before the checkpoint.
 * @param resolve - session-scoped resolver for referenced audit payloads.
 * @param consume - complete reads before returning; the spool is removed afterward.
 * @returns the callback result after cleanup.
 */
export async function withVerifiedCodexCheckpointArtifactV2<Result>(
  chunks: AsyncIterable<Uint8Array>,
  receipt: { readonly sha256: string; readonly bytes: number },
  checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>,
  preceding: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
  consume: (read: VerifiedCodexCheckpointRead) => Promise<Result> | Result,
): Promise<Result> {
  const lease = await openVerifiedCodexCheckpointArtifactV2(chunks, receipt, checkpoint, preceding, resolve)
  try {
    return await consume(lease.read)
  } finally {
    await lease.close()
  }
}

/** Stream a projection while its verified checkpoint spool exists.
 * Validation starts on first consumption; EOF, projection errors and iterator
 * cancellation all close the spool. A caller must consume to EOF before using
 * a streamed result as a complete export.
 * @param chunks - streamed checkpoint bytes from the session-owned artifact.
 * @param receipt - expected byte count and SHA-256 of those bytes.
 * @param checkpoint - audit fact binding the checkpoint to its history hash.
 * @param preceding - ordered facts committed before the checkpoint.
 * @param resolve - session-scoped resolver for referenced audit payloads.
 * @param project - projection fully consumed before the spool closes.
 * @returns projected values while the private spool remains valid.
 */
export async function* streamVerifiedCodexCheckpointArtifactV2<Value>(
  chunks: AsyncIterable<Uint8Array>,
  receipt: { readonly sha256: string; readonly bytes: number },
  checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>,
  preceding: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
  project: (read: VerifiedCodexCheckpointRead) => AsyncIterable<Value>,
): AsyncGenerator<Value> {
  const lease = await openVerifiedCodexCheckpointArtifactV2(chunks, receipt, checkpoint, preceding, resolve)
  try {
    yield* project(lease.read)
  } finally {
    await lease.close()
  }
}

/** Verify a checkpoint without retaining its complete payload.
 * @param chunks - streamed checkpoint bytes from the owning artifact.
 * @param receipt - expected byte count and SHA-256.
 * @param checkpoint - checkpoint audit fact.
 * @param preceding - ordered earlier facts.
 * @param resolve - session-scoped audit payload resolver.
 * @returns runtime revision extracted from the validated V2 payload.
 */
export function verifyCodexCheckpointArtifactV2(
  chunks: AsyncIterable<Uint8Array>,
  receipt: { readonly sha256: string; readonly bytes: number },
  checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>,
  preceding: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
): Promise<string> {
  return withVerifiedCodexCheckpointArtifactV2(chunks, receipt, checkpoint, preceding,
    resolve, read => read.runtimeRevision)
}
