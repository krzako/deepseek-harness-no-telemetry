/** Complete audited attempts behind an installed Codex compaction. */

import type { PortableCompactionV1, PortableContextItemV1, PortableOpaqueContextItemStreamV1 } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { codexPortableFailureJson, type CodexPortableJsonStream } from './portable-json.ts'
import { isDeepStrictEqual } from 'node:util'
import type { CodexAuditEventV1, CodexAuditPayloadV1 } from './audit-contract.ts'
import { codexJsonArraySha256, isCodexContextSnapshotV2, type CodexCheckpointPayloadResolver, type CodexContextSnapshotV2 } from './context-snapshot.ts'
import type { CodexPortableHistoricalItems } from './portable-item.ts'
import { projectCodexResponseItem } from './portable-item.ts'

/** One model attempt and its durable settlement. */
export interface CodexPortableCompactionAttempt<History = readonly JsonValue[], Payload = JsonValue> {
  readonly requestEventId: string
  readonly settlementEventId: string
  readonly inputHistory: History
  readonly prompt: Payload
  readonly result?: Payload
  readonly failure?: { readonly message: string; readonly details?: Payload }
}

/** One installed compaction and all attempts that led to its replacement history. */
export interface CodexPortableCompactionAudit<History = readonly JsonValue[], Payload = JsonValue> {
  readonly id: string
  readonly turn: number
  readonly attempts: readonly CodexPortableCompactionAttempt<History, Payload>[]
  readonly replacementHistory: readonly JsonValue[]
}

function jsonArray(value: unknown): value is JsonValue[] {
  return Array.isArray(value) && value.every(isJsonValue)
}

function json(value: unknown): value is JsonValue {
  return isJsonValue(value)
}

async function historyMatches(
  payload: CodexAuditPayloadV1,
  expected: readonly JsonValue[],
  resolve: CodexCheckpointPayloadResolver,
): Promise<boolean> {
  if (resolve.historySha256 !== undefined) {
    return await resolve.historySha256(payload) === await codexJsonArraySha256(expected.length, asAsync(expected))
  }
  return isDeepStrictEqual(await resolve(payload), expected)
}

/**
 * Resolve all model attempts and installation facts for every V2 compaction.
 * Failed attempts remain explicit; only a final successful result may install
 * replacement history. No historical model or tool side effect is replayed.
 * @param checkpoint - untrusted V2 checkpoint payload.
 * @param events - committed audit facts in sequence order for this thread.
 * @param resolve - session-owned inline/artifact payload resolver.
 * @returns ordered complete audit groups for installed compactions.
 */
export async function resolveCodexInstalledCompactions(
  checkpoint: unknown,
  events: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
): Promise<readonly CodexPortableCompactionAudit[]> {
  if (!isCodexContextSnapshotV2(checkpoint)) throw new TypeError('Invalid Codex V2 checkpoint for compaction audit')
  const installed: CodexPortableCompactionAudit[] = []
  for await (const group of resolveCodexInstalledCompactionsStream(checkpoint.compactions, events, resolve)) {
    installed.push(group)
  }
  return installed
}

function checkpointCompaction(value: unknown): value is CodexContextSnapshotV2['compactions'][number] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 5 || !['id', 'summary', 'replacementHistory', 'responseId', 'windowId']
    .every(key => Object.hasOwn(item, key)) || typeof item.id !== 'string' || item.id.length === 0
    || typeof item.summary !== 'string' || !jsonArray(item.replacementHistory)
    || item.replacementHistory.length === 0 || (item.responseId !== null && typeof item.responseId !== 'string')
    || (item.windowId !== null && typeof item.windowId !== 'string')) return false
  const last = item.replacementHistory.at(-1)
  return last !== null && typeof last === 'object' && !Array.isArray(last)
    && last.metadata !== null && typeof last.metadata === 'object' && !Array.isArray(last.metadata)
    && last.metadata.dsh_compaction_id === item.id
}

/**
 * Resolve one verified checkpoint compaction at a time. The caller must first
 * verify the whole V2 checkpoint and audit stream; no group is final until this
 * iterator reaches EOF without an error.
 * @param compactions - single-consumption compaction objects from a verified checkpoint.
 * @param events - committed audit facts in sequence order for this thread.
 * @param resolve - session-owned inline/artifact payload resolver.
 * @returns ordered complete audit groups for installed compactions.
 */
export function resolveCodexInstalledCompactionsStream(
  compactions: AsyncIterable<unknown> | Iterable<unknown>,
  events: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
): AsyncGenerator<CodexPortableCompactionAudit> {
  return resolveCompactions(compactions, events, resolve, async (payload) => {
    const value = await resolve(payload)
    if (!jsonArray(value)) throw new Error('Codex compaction has invalid request payload')
    return value
  }, (payload, prompt) => resolveResidentPayload(resolve, payload, prompt))
}

/** Resolve installed groups while retaining only readers for attempt input histories.
 * Every attempt's history is consumed and verified before its group is yielded;
 * the final attempt is read again by projection, which must also reach EOF.
 * @param compactions - verified checkpoint compactions in installation order.
 * @param events - committed audit facts in sequence order.
 * @param resolve - session-owned resolver for prompts, settlements and history digests.
 * @param readHistory - fresh receipt-verified array iterator for each invocation.
 * @param readPayload - admission of resident or verified opaque attempt payloads.
 * @returns audit groups with lazy input histories and admitted prompts/results.
 */
export function resolveCodexInstalledCompactionsWithStreamedHistory(
  compactions: AsyncIterable<unknown> | Iterable<unknown>,
  events: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
  readHistory: (payload: CodexAuditPayloadV1) => AsyncIterable<JsonValue>,
  readPayload: (payload: CodexAuditPayloadV1, prompt: boolean) => Promise<JsonValue | CodexPortableJsonStream>
    = (payload, prompt) => resolveResidentPayload(resolve, payload, prompt),
): AsyncGenerator<CodexPortableCompactionAudit<AsyncIterable<JsonValue>, JsonValue | CodexPortableJsonStream>> {
  return resolveCompactions(compactions, events, resolve, async (payload) => {
    for await (const _item of readHistory(payload)) { /* verify the entire attempt, including failed retries */ }
    return readHistory(payload)
  }, readPayload)
}

async function resolveResidentPayload(
  resolve: CodexCheckpointPayloadResolver, payload: CodexAuditPayloadV1, prompt: boolean,
): Promise<JsonValue> {
  const value = await resolve(payload)
  if (!json(value) || (prompt && (value === null || typeof value !== 'object' || Array.isArray(value)))) {
    throw new Error(`Codex compaction has invalid ${prompt ? 'request' : 'result'} payload`)
  }
  return value
}

async function* resolveCompactions<History, Payload>(
  compactions: AsyncIterable<unknown> | Iterable<unknown>,
  events: readonly CodexAuditEventV1[],
  resolve: CodexCheckpointPayloadResolver,
  readHistory: (payload: CodexAuditPayloadV1) => Promise<History>,
  readPayload: (payload: CodexAuditPayloadV1, prompt: boolean) => Promise<Payload>,
): AsyncGenerator<CodexPortableCompactionAudit<History, Payload>> {
  for (let index = 1; index < events.length; index++) {
    const current = events[index]
    const previous = events[index - 1]
    if (current === undefined || previous === undefined || current.sequence <= previous.sequence) {
      throw new Error('Codex compaction audit sequence is not strictly increasing')
    }
  }
  const seen = new Set<string>()
  for await (const compaction of compactions) {
    if (!checkpointCompaction(compaction) || seen.has(compaction.id)) {
      throw new TypeError('Invalid or duplicate Codex V2 compaction for audit')
    }
    seen.add(compaction.id)
    const facts = events.filter(event => 'compactionId' in event && event.compactionId === compaction.id)
      .filter(event => event.kind.startsWith('compaction/'))
    const attempts: CodexPortableCompactionAttempt<History, Payload>[] = []
    let open: { requestEventId: string; inputHistory: History; prompt: Payload } | undefined
    let pending = false
    let completed = false
    let threadId: string | undefined
    let turn: number | undefined
    for (const fact of facts) {
      if (threadId !== undefined && (fact.threadId !== threadId || fact.turn !== turn)) {
        throw new Error(`Codex compaction ${compaction.id} spans multiple threads or turns`)
      }
      threadId = fact.threadId
      turn = fact.turn
      switch (fact.kind) {
        case 'compaction/request': {
          if (open !== undefined || pending || completed) throw new Error(`Codex compaction ${compaction.id} has overlapping requests`)
          const inputHistory = await readHistory(fact.inputHistory)
          const prompt = await readPayload(fact.prompt, true)
          open = { requestEventId: fact.eventId, inputHistory, prompt }
          break
        }
        case 'compaction/result':
        case 'compaction/failure': {
          if (open === undefined || pending || completed) throw new Error(`Codex compaction ${compaction.id} has unbound settlement`)
          if (fact.kind === 'compaction/result') {
            const result = await readPayload(fact.result, false)
            attempts.push({ ...open, settlementEventId: fact.eventId, result })
          } else {
            const details = fact.details === undefined ? undefined : await readPayload(fact.details, false)
            attempts.push({ ...open, settlementEventId: fact.eventId,
              failure: { message: fact.message, ...details === undefined ? {} : { details } } })
          }
          open = undefined
          break
        }
        case 'compaction/pending': {
          if (open !== undefined || pending || completed || attempts.at(-1)?.result === undefined) {
            throw new Error(`Codex compaction ${compaction.id} has no successful settled attempt before pending`)
          }
          if (!await historyMatches(fact.effectiveHistory, compaction.replacementHistory, resolve)) {
            throw new Error(`Codex compaction ${compaction.id} pending history differs from checkpoint`)
          }
          pending = true
          break
        }
        case 'compaction/installed': {
          if (!pending || completed) throw new Error(`Codex compaction ${compaction.id} has no matching pending history`)
          if (!await historyMatches(fact.effectiveHistory, compaction.replacementHistory, resolve)) {
            throw new Error(`Codex compaction ${compaction.id} installed history differs from checkpoint`)
          }
          completed = true
          break
        }
        default:
          throw new Error(`Codex compaction ${compaction.id} has unexpected ${fact.kind} after installation`)
      }
    }
    if (!completed || open !== undefined || turn === undefined) {
      throw new Error(`Codex compaction ${compaction.id} audit is incomplete`)
    }
    yield { id: compaction.id, turn, attempts, replacementHistory: compaction.replacementHistory }
  }
}

/** Canonical compaction provenance, not the active history itself. */
export interface CodexPortableCompactionProjection {
  readonly items: readonly PortableContextItemV1[]
  readonly compactions: readonly PortableCompactionV1[]
}

function object(value: JsonValue): { readonly [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function compactionMode(prompt: JsonValue): PortableCompactionV1['mode'] {
  const metadata = object(prompt)?.compactionMetadata
  const implementation = metadata === undefined ? undefined : object(metadata)?.implementation
  if (implementation === 'responses') return 'local'
  if (implementation === 'responses_compaction_v2') return 'remote'
  throw new Error('Codex compaction prompt has no supported audited implementation')
}

function projectAttempts<History>(
  audit: CodexPortableCompactionAudit<History>,
  output: CodexPortableHistoricalItems['compactionOutputs'][number] | undefined,
) {
  const items: PortableContextItemV1[] = []
  const first = audit.attempts[0]
  const last = audit.attempts.at(-1)
  if (output === undefined || output.id !== audit.id || first === undefined
    || last === undefined || last.result === undefined) {
    throw new Error(`Codex compaction ${audit.id} has no matching successful rollout output`)
  }
  const mode = compactionMode(first.prompt)
  const promptItemIds: string[] = []
  const resultItemIds: string[] = []
  for (const [index, attempt] of audit.attempts.entries()) {
    if (compactionMode(attempt.prompt) !== mode) {
      throw new Error(`Codex compaction ${audit.id} changed implementation during retry`)
    }
    const prefix = `codex:compaction:${audit.id}:attempt:${index}`
    const promptId = `${prefix}:prompt`
    const resultId = `${prefix}:result`
    items.push({ id: promptId, role: 'developer',
      content: [{ kind: 'opaque', namespace: 'codex.compaction.prompt.v1', value: attempt.prompt }],
      provenance: { kind: 'compaction', sourceId: attempt.requestEventId } })
    let settlement: { namespace: string; value: JsonValue }
    if (attempt.result !== undefined) {
      settlement = { namespace: 'codex.compaction.result.v1', value: attempt.result }
    } else if (attempt.failure !== undefined) {
      settlement = { namespace: 'codex.compaction.failure.v1', value: {
        message: attempt.failure.message,
        ...attempt.failure.details === undefined ? {} : { details: attempt.failure.details },
      } }
    } else {
      throw new Error(`Codex compaction ${audit.id} has an unsettled attempt`)
    }
    items.push({ id: resultId, role: 'assistant',
      content: [{ kind: 'opaque', ...settlement }],
      provenance: { kind: 'compaction', sourceId: attempt.settlementEventId } })
    promptItemIds.push(promptId)
    resultItemIds.push(resultId)
  }
  return { items, mode, promptItemIds, resultItemIds, last, outputItemIds: output.outputItemIds }
}

/**
 * Link audited compaction attempts to canonical input, prompt, result, and
 * installed-output items. Raw prompts/results remain namespaced provenance;
 * a target driver must report compatibility instead of treating them as turns.
 * @param audits - validated, ordered installed compaction audit groups.
 * @param historical - rollout projection whose output IDs belong to each group.
 * @param firstResponseIndex - first unused numeric canonical Responses item ID.
 * @param outcomes - committed DSH tool outcomes indexed by Codex call ID.
 * @returns canonical provenance items and compaction relationships.
 */
export function projectCodexCompactionAncestry(
  audits: readonly CodexPortableCompactionAudit[],
  historical: CodexPortableHistoricalItems,
  firstResponseIndex: number,
  outcomes: ReadonlyMap<string, 'success' | 'error'>,
): CodexPortableCompactionProjection {
  if (!Number.isSafeInteger(firstResponseIndex) || firstResponseIndex < 0) {
    throw new TypeError('Codex compaction response index must be nonnegative')
  }
  if (audits.length !== historical.compactionOutputs.length) {
    throw new Error('Codex compaction audit differs from rollout projection')
  }
  const items: PortableContextItemV1[] = []
  const compactions: PortableCompactionV1[] = []
  let responseIndex = firstResponseIndex
  for (const [ordinal, audit] of audits.entries()) {
    const output = historical.compactionOutputs[ordinal]
    const { items: attempts, mode, promptItemIds, resultItemIds, last, outputItemIds } = projectAttempts(audit, output)
    for (const item of attempts) items.push(item)
    const inputItemIds: string[] = []
    for (const input of last.inputHistory) {
      const value = object(input)
      const callId = value?.type === 'function_call_output' && typeof value.call_id === 'string'
        ? value.call_id : undefined
      const item = projectCodexResponseItem({ item: input }, responseIndex++,
        callId === undefined ? undefined : outcomes.get(callId))
      items.push(item)
      inputItemIds.push(item.id)
    }
    compactions.push({ id: audit.id, mode, inputItemIds, outputItemIds,
      promptItemIds, resultItemIds })
  }
  return { items, compactions }
}

function streamed(value: JsonValue | CodexPortableJsonStream): value is CodexPortableJsonStream {
  return value !== null && typeof value === 'object' && 'read' in value && typeof value.read === 'function'
}

async function projectStreamAttempts<History>(
  audit: CodexPortableCompactionAudit<History, JsonValue | CodexPortableJsonStream>,
  output: CodexPortableHistoricalItems['compactionOutputs'][number],
) {
  const replacements = new Map<string, CodexPortableJsonStream>()
  const attempts: CodexPortableCompactionAttempt<History>[] = []
  for (const [index, attempt] of audit.attempts.entries()) {
    const prefix = `codex:compaction:${audit.id}:attempt:${index}`
    let prompt = attempt.prompt
    if (streamed(prompt)) {
      if (prompt.mode === undefined) throw new Error('Codex compaction prompt has no supported audited implementation')
      replacements.set(`${prefix}:prompt`, prompt)
      prompt = { compactionMetadata: { implementation: prompt.mode === 'local' ? 'responses' : 'responses_compaction_v2' } }
    }
    let result = attempt.result
    if (result !== undefined && streamed(result)) {
      replacements.set(`${prefix}:result`, result)
      result = null
    }
    let failure: CodexPortableCompactionAttempt<History>['failure']
    if (attempt.failure !== undefined) {
      const { message, details } = attempt.failure
      if (details !== undefined && streamed(details)) {
        replacements.set(`${prefix}:result`, await codexPortableFailureJson(message, details))
        failure = { message, details: null }
      } else failure = { message, ...details === undefined ? {} : { details } }
    }
    attempts.push({ requestEventId: attempt.requestEventId, settlementEventId: attempt.settlementEventId,
      inputHistory: attempt.inputHistory, prompt,
      ...result === undefined ? {} : { result }, ...failure === undefined ? {} : { failure } })
  }
  const projected = projectAttempts({ ...audit, attempts }, output)
  const items = projected.items.map((item): PortableContextItemV1 | PortableOpaqueContextItemStreamV1 => {
    const replacement = replacements.get(item.id)
    if (replacement === undefined) return item
    const block = item.content[0]
    if (block?.kind !== 'opaque') throw new Error('Codex compaction projection is not opaque')
    return { encoding: 'opaque-json', id: item.id, role: item.role, namespace: block.namespace,
      provenance: item.provenance, json: replacement.json }
  })
  return { ...projected, items }
}

async function* asAsync<Value>(values: AsyncIterable<Value> | Iterable<Value>): AsyncGenerator<Value> {
  for await (const value of values) yield value
}

/**
 * Project audited compaction provenance one installed group at a time. The
 * caller receives a relation only after all of that group's items have been
 * yielded and must consume the iterator to EOF before publishing an export.
 * @param audits - ordered, resolved compaction audit groups.
 * @param outputs - matching rollout replacement-item references in order.
 * @param firstResponseIndex - first unused numeric canonical Responses item ID.
 * @param outcomes - committed DSH tool outcomes indexed by Codex call ID.
 * @param onCompaction - accept a complete canonical relation after its items.
 * @returns canonical input, prompt, and settlement items in compaction order.
 */
export async function* projectCodexCompactionAncestryStream(
  audits: AsyncIterable<CodexPortableCompactionAudit<readonly JsonValue[] | AsyncIterable<JsonValue>, JsonValue | CodexPortableJsonStream>>
    | Iterable<CodexPortableCompactionAudit<readonly JsonValue[] | AsyncIterable<JsonValue>, JsonValue | CodexPortableJsonStream>>,
  outputs: AsyncIterable<CodexPortableHistoricalItems['compactionOutputs'][number]>
    | Iterable<CodexPortableHistoricalItems['compactionOutputs'][number]>,
  firstResponseIndex: number,
  outcomes: ReadonlyMap<string, 'success' | 'error'>,
  onCompaction: (compaction: PortableCompactionV1) => void,
): AsyncGenerator<PortableContextItemV1 | PortableOpaqueContextItemStreamV1> {
  if (!Number.isSafeInteger(firstResponseIndex) || firstResponseIndex < 0) {
    throw new TypeError('Codex compaction response index must be nonnegative')
  }
  const outputIterator = asAsync(outputs)
  let responseIndex = firstResponseIndex
  try {
    for await (const audit of audits) {
      const next = await outputIterator.next()
      if (next.done) throw new Error(`Codex compaction ${audit.id} has no matching rollout output`)
      const { items, mode, promptItemIds, resultItemIds, last, outputItemIds } = await projectStreamAttempts(audit, next.value)
      yield* items
      const inputItemIds: string[] = []
      for await (const input of last.inputHistory) {
        const value = object(input)
        const callId = value?.type === 'function_call_output' && typeof value.call_id === 'string'
          ? value.call_id : undefined
        const item = projectCodexResponseItem({ item: input }, responseIndex++,
          callId === undefined ? undefined : outcomes.get(callId))
        inputItemIds.push(item.id)
        yield item
      }
      onCompaction({ id: audit.id, mode, inputItemIds, outputItemIds,
        promptItemIds, resultItemIds })
    }
    if (!(await outputIterator.next()).done) {
      throw new Error('Codex compaction rollout has an extra installation')
    }
  } finally {
    await outputIterator.return(undefined)
  }
}
