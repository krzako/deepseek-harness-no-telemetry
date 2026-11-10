/** Codex-owned checkpoint carried inside the shared DSH Session archive. */

import type { PrivateDriverSnapshotV1 } from '@deepseek-ai/dsh-agent'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { createHash, type Hash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CodexAuditEventV1, CodexAuditPayloadV1 } from './audit-contract.ts'

/** Codex checkpoint payload version, independent of the DSH archive version. */
export const CODEX_CONTEXT_SNAPSHOT_VERSION = 1 as const

/** One native item and its stable rollout identity. */
export interface CodexSnapshotItemV1 {
  readonly id: string
  readonly value: JsonValue
}

/** Exact Codex context inputs needed to assemble the next model request. */
export interface CodexContextSnapshotV1 {
  readonly version: typeof CODEX_CONTEXT_SNAPSHOT_VERSION
  readonly runtimeRevision: string
  readonly items: readonly CodexSnapshotItemV1[]
  readonly effectiveItemIds: readonly string[]
  readonly compactions: readonly {
    readonly id: string
    readonly inputItemIds: readonly string[]
    readonly outputItemIds: readonly string[]
    readonly prompt: JsonValue
    readonly result: JsonValue
  }[]
  readonly promptConfig: {
    readonly model: string
    readonly provider: string
    readonly systemInstructions: string
    readonly developerInstructions: string
    readonly reasoningEffort: string | null
    readonly toolSchemas: JsonValue
  }
}

/** Native model history and durable rollout provenance from a fork capture. */
export interface CodexContextSnapshotV2 {
  readonly version: 2
  readonly hashAlgorithm: 'dsh-json-v1'
  readonly runtimeRevision: string
  readonly historyVersion: number
  readonly effectiveHistory: readonly JsonValue[]
  readonly effectiveHistorySha256: string
  readonly retainedContext: JsonValue
  readonly compactions: readonly {
    readonly id: string
    readonly summary: string
    readonly replacementHistory: readonly JsonValue[]
    readonly responseId: string | null
    readonly windowId: string | null
  }[]
  /** Provenance only: import must never replay its old model or tool side effects. */
  readonly rollout: readonly JsonValue[]
  readonly rolloutSha256: string
  readonly contextConfig: JsonValue
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key))
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function jsonArray(value: unknown): value is JsonValue[] {
  return Array.isArray(value) && value.every(isJsonValue)
}

/** Typed JSON hash shared with the fork; keys sort by UTF-8 and numbers use f64 bits. */
function updateCodexJsonHash(hash: Hash, value: JsonValue): void {
  const length = (size: number): void => {
    const bytes = Buffer.allocUnsafe(8)
    bytes.writeBigUInt64BE(BigInt(size))
    hash.update(bytes)
  }
  const visit = (item: JsonValue): void => {
    if (item === null) hash.update('N')
    else if (typeof item === 'boolean') hash.update(item ? 'T' : 'F')
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('non-finite JSON number')
      hash.update('D')
      const bytes = Buffer.allocUnsafe(8)
      bytes.writeDoubleBE(item)
      hash.update(bytes)
    } else if (typeof item === 'string') {
      hash.update('S')
      const bytes = Buffer.from(item, 'utf8')
      length(bytes.byteLength)
      hash.update(bytes)
    } else if (Array.isArray(item)) {
      hash.update('A')
      length(item.length)
      for (const child of item) visit(child)
    } else {
      hash.update('O')
      const entries = Object.entries(item).sort(([left], [right]) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)))
      length(entries.length)
      for (const [key, child] of entries) {
        const bytes = Buffer.from(key, 'utf8')
        length(bytes.byteLength)
        hash.update(bytes)
        visit(child)
      }
    }
  }
  visit(value)
}

/** Hash one canonical JSON value using the fork's DSH JSON encoding.
 * @param value - complete JSON value to hash.
 * @returns lowercase SHA-256 hex digest.
 */
export function codexJsonSha256(value: JsonValue): string {
  const hash = createHash('sha256')
  updateCodexJsonHash(hash, value)
  return hash.digest('hex')
}

/** Hash a JSON array one validated element at a time, never retaining the array.
 * @param count - expected element count in the canonical array encoding.
 * @param items - ordered JSON elements consumed once.
 * @returns lowercase SHA-256 hex digest after count validation.
 */
export async function codexJsonArraySha256(count: number, items: AsyncIterable<JsonValue>): Promise<string> {
  const hash = createHash('sha256')
  hash.update('A')
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(count))
  hash.update(length)
  let seen = 0
  for await (const item of items) {
    if (!isJsonValue(item)) throw new TypeError('non-JSON checkpoint array item')
    updateCodexJsonHash(hash, item)
    seen++
  }
  if (seen !== count) throw new Error('checkpoint array changed while streaming')
  return hash.digest('hex')
}

function rolloutCompactionsAgree(snapshot: CodexContextSnapshotV2): boolean {
  const installed = snapshot.rollout.filter(item => record(item) && item.type === 'compacted')
  if (installed.length !== snapshot.compactions.length) return false
  return installed.every((item, index) => {
    if (!record(item) || !record(item.payload)) return false
    const payload = item.payload
    const compaction = snapshot.compactions[index]
    if (compaction === undefined || payload.message !== compaction.summary
      || (payload.window_id ?? null) !== compaction.windowId
      || (payload.compaction_response_id ?? null) !== compaction.responseId
      || !jsonArray(payload.replacement_history)) return false
    const history = payload.replacement_history
    const metadata = payload.replacement_history_metadata
    if (metadata !== undefined && (!jsonArray(metadata) || metadata.length !== history.length)) return false
    const envelopes = history.map((value, offset) => ({
      item: value,
      ...(metadata === undefined ? {} : { metadata: metadata[offset] }),
    }))
    return isDeepStrictEqual(envelopes, compaction.replacementHistory)
  })
}

function ids(value: unknown, known: ReadonlySet<string>): value is string[] {
  return Array.isArray(value) && value.every(item => nonempty(item) && known.has(item))
    && new Set(value).size === value.length
}

/**
 * Validate a checkpoint from archive or app-server before any thread restoration.
 * @param value - parsed Codex checkpoint payload.
 * @returns whether native items, references, and prompt configuration are valid.
 */
export function isCodexContextSnapshotV1(value: unknown): value is CodexContextSnapshotV1 {
  if (!record(value) || !exact(value, ['version', 'runtimeRevision', 'items', 'effectiveItemIds', 'compactions', 'promptConfig'])
    || value.version !== CODEX_CONTEXT_SNAPSHOT_VERSION || !nonempty(value.runtimeRevision)
    || !Array.isArray(value.items)) return false
  const items: unknown[] = value.items
  const known = new Set<string>()
  for (const item of items) {
    if (!record(item) || !exact(item, ['id', 'value']) || !nonempty(item.id) || !isJsonValue(item.value)
      || known.has(item.id)) return false
    known.add(item.id)
  }
  if (!ids(value.effectiveItemIds, known) || !Array.isArray(value.compactions)) return false
  const compactions: unknown[] = value.compactions
  const compactionIds = new Set<string>()
  for (const compaction of compactions) {
    if (!record(compaction) || !exact(compaction, ['id', 'inputItemIds', 'outputItemIds', 'prompt', 'result'])
      || !nonempty(compaction.id) || compactionIds.has(compaction.id)
      || !ids(compaction.inputItemIds, known) || !ids(compaction.outputItemIds, known)
      || !isJsonValue(compaction.prompt) || !isJsonValue(compaction.result)) return false
    compactionIds.add(compaction.id)
  }
  const config = value.promptConfig
  return record(config) && exact(config, ['model', 'provider', 'systemInstructions', 'developerInstructions', 'reasoningEffort', 'toolSchemas'])
    && nonempty(config.model) && nonempty(config.provider) && typeof config.systemInstructions === 'string'
    && typeof config.developerInstructions === 'string'
    && (config.reasoningEffort === null || typeof config.reasoningEffort === 'string') && isJsonValue(config.toolSchemas)
}

/** Reject malformed V2 checkpoints before they enter the shared driver-private slot.
 * @param value - untrusted checkpoint payload.
 * @returns whether the payload and its self-hashes satisfy the V2 format.
 */
export function isCodexContextSnapshotV2(value: unknown): value is CodexContextSnapshotV2 {
  if (!record(value) || !exact(value, [
    'version', 'hashAlgorithm', 'runtimeRevision', 'historyVersion', 'effectiveHistory', 'effectiveHistorySha256',
    'retainedContext', 'compactions', 'rollout', 'rolloutSha256', 'contextConfig',
  ]) || value.version !== 2 || value.hashAlgorithm !== 'dsh-json-v1' || !nonempty(value.runtimeRevision)
    || !Number.isSafeInteger(value.historyVersion) || (value.historyVersion as number) < 0
    || !jsonArray(value.effectiveHistory) || !sha256(value.effectiveHistorySha256)
    || !record(value.retainedContext) || !isJsonValue(value.retainedContext)
    || !jsonArray(value.rollout) || !sha256(value.rolloutSha256)
    || !record(value.contextConfig) || value.contextConfig.schemaVersion !== 1
    || !isJsonValue(value.contextConfig) || !Array.isArray(value.compactions)) return false
  const ids = new Set<string>()
  for (const item of value.compactions) {
    if (!record(item) || !exact(item, ['id', 'summary', 'replacementHistory', 'responseId', 'windowId'])
      || !nonempty(item.id) || ids.has(item.id) || typeof item.summary !== 'string'
      || !jsonArray(item.replacementHistory) || item.replacementHistory.length === 0
      || (item.responseId !== null && typeof item.responseId !== 'string')
      || (item.windowId !== null && typeof item.windowId !== 'string')) return false
    const last = item.replacementHistory.at(-1)
    if (!record(last) || !record(last.metadata) || last.metadata.dsh_compaction_id !== item.id) return false
    ids.add(item.id)
  }
  return codexJsonSha256(value.effectiveHistory) === value.effectiveHistorySha256
    && codexJsonSha256(value.rollout) === value.rolloutSha256
    && rolloutCompactionsAgree(value as unknown as CodexContextSnapshotV2)
}

/** Check the fork's V2 payload against the preceding, durably ordered DSH facts.
 * @param value - untrusted checkpoint payload.
 * @param checkpoint - audit fact claiming the checkpoint.
 * @param preceding - ordered facts committed before it.
 * @param resolve - resolver for referenced audit payloads.
 * @returns validated checkpoint after audit correlation.
 */
export async function verifyCodexCheckpointAuditV2(
  value: unknown,
  checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>,
  preceding: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
): Promise<CodexContextSnapshotV2> {
  if (!isCodexContextSnapshotV2(value)) throw new Error('agent-codex: invalid V2 checkpoint content or hash')
  await verifyCodexCheckpointAuditSummaryV2({
    effectiveHistorySha256: value.effectiveHistorySha256,
    contextConfig: value.contextConfig,
    compactions: value.compactions.map(compaction => ({
      id: compaction.id,
      replacementHistorySha256: codexJsonSha256(compaction.replacementHistory as JsonValue[]),
    })),
  }, checkpoint, preceding, resolve)
  return value
}

/** Minimal validated projection retained by the streaming checkpoint verifier. */
export interface CodexCheckpointSummaryV2 {
  readonly effectiveHistorySha256: string
  readonly contextConfig: JsonValue
  readonly compactions: readonly { readonly id: string; readonly replacementHistorySha256: string }[]
}

/** Payload reader with optional incremental verification for artifact histories and configuration. */
export type CodexCheckpointPayloadResolver = ((payload: CodexAuditPayloadV1) => Promise<unknown>) & {
  /** Validate the complete array and its receipt before returning its dsh-json-v1 digest. */
  historySha256?: (payload: CodexAuditPayloadV1) => Promise<string>
  /** Compare configuration properties only after verifying the complete artifact receipt. */
  configurationMatches?: (payload: CodexAuditPayloadV1, expected: JsonValue) => Promise<boolean>
}

/** Verify references to prior facts without retaining the whole snapshot artifact.
 * @param value - validated streaming checkpoint summary.
 * @param checkpoint - audit fact claiming the checkpoint.
 * @param preceding - ordered facts committed before it.
 * @param resolve - resolver for referenced audit payloads.
 */
export async function verifyCodexCheckpointAuditSummaryV2(
  value: CodexCheckpointSummaryV2,
  checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>,
  preceding: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
): Promise<void> {
  if (checkpoint.effectiveHistorySha256 !== value.effectiveHistorySha256) {
    throw new Error('agent-codex: checkpoint fact history hash differs from its snapshot')
  }
  const configuration = preceding.findLast(event => event.kind === 'context/config'
    && event.turn === checkpoint.turn)
  if (configuration === undefined || configuration.kind !== 'context/config'
    || !(resolve.configurationMatches === undefined
      ? isDeepStrictEqual(await resolve(configuration.config), value.contextConfig)
      : await resolve.configurationMatches(configuration.config, value.contextConfig))) {
    throw new Error('agent-codex: checkpoint has no matching accepted turn configuration')
  }
  const installedFacts = preceding.filter(event => event.kind === 'compaction/installed')
  if (installedFacts.length !== value.compactions.length
    || new Set(installedFacts.map(event => event.compactionId)).size !== installedFacts.length) {
    throw new Error('agent-codex: checkpoint compaction chain differs from installed facts')
  }
  for (const compaction of value.compactions) {
    const pending = preceding.find(event => event.kind === 'compaction/pending'
      && event.compactionId === compaction.id)
    const installed = preceding.find(event => event.kind === 'compaction/installed'
      && event.compactionId === compaction.id)
    if (pending?.kind !== 'compaction/pending' || installed?.kind !== 'compaction/installed'
      || pending.sequence >= installed.sequence || installed.sequence >= checkpoint.sequence
      || !await matchesHistory(pending.effectiveHistory, compaction.replacementHistorySha256, resolve)
      || !await matchesHistory(installed.effectiveHistory, compaction.replacementHistorySha256, resolve)) {
      throw new Error(`agent-codex: checkpoint compaction ${compaction.id} has no matching installed fact`)
    }
  }
  if (checkpoint.checkpointId.startsWith('compaction:')) {
    const id = checkpoint.checkpointId.slice('compaction:'.length)
    if (!value.compactions.some(compaction => compaction.id === id)) {
      throw new Error(`agent-codex: checkpoint trigger ${id} has no installed compaction`)
    }
  }
}

async function matchesHistory(
  payload: CodexAuditPayloadV1,
  expectedSha256: string,
  resolve: CodexCheckpointPayloadResolver,
): Promise<boolean> {
  if (resolve.historySha256 !== undefined) return await resolve.historySha256(payload) === expectedSha256
  const value = await resolve(payload)
  return jsonArray(value) && codexJsonSha256(value) === expectedSha256
}

/**
 * Wrap a validated Codex checkpoint in the universal namespaced driver slot.
 * @param context - Codex checkpoint, checked again before wrapping.
 * @returns the shared driver-private checkpoint envelope.
 * @throws when the Codex checkpoint is malformed.
 */
export function codexPrivateSnapshot(context: CodexContextSnapshotV1 | CodexContextSnapshotV2): PrivateDriverSnapshotV1 {
  if (!isCodexContextSnapshotV1(context) && !isCodexContextSnapshotV2(context)) throw new TypeError('invalid Codex context snapshot')
  return { version: 1, driverId: 'codex', driverRevision: context.runtimeRevision, schemaVersion: context.version, context: context as unknown as JsonValue }
}
