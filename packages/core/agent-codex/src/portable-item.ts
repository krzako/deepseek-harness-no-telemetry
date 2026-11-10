/** Lossless, driver-neutral projection of one Codex Responses history envelope. */

import type { PortableContentBlockV1, PortableContextItemV1 } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { isCodexContextSnapshotV2 } from './context-snapshot.ts'
import type {} from './types.ts'

type JsonObject = { readonly [key: string]: JsonValue }
type ToolOutcome = 'success' | 'error'

/**
 * Join durable Codex call identities to DSH's committed tool outcomes.
 * An uncompleted call has no outcome and stays opaque in a projected history.
 * @param events - one Codex Session's committed events in sequence order.
 * @returns outcomes keyed by Codex call ID, excluding uncompleted calls.
 */
export function codexPortableToolOutcomes(events: readonly SessionEvent[]): ReadonlyMap<string, ToolOutcome> {
  const byDsh = new Map<string, { readonly codexCallId: string; readonly turn: number }>()
  const codexIds = new Set<string>()
  for (const event of events) {
    if (event.type !== 'codex/tool-call-bound') continue
    const { codexCallId, dshCallId, turn } = event.data
    if (codexIds.has(codexCallId) || byDsh.has(dshCallId)) {
      throw new Error('agent-codex: duplicate portable tool binding')
    }
    codexIds.add(codexCallId)
    byDsh.set(dshCallId, { codexCallId, turn })
  }
  const outcomes = new Map<string, ToolOutcome>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const result = event.data.message.content[0]
    const binding = byDsh.get(result.toolCallId)
    if (binding === undefined || event.data.turn !== binding.turn
      || outcomes.has(binding.codexCallId)) {
      throw new Error('agent-codex: unbound, conflicting, or duplicate portable tool result')
    }
    outcomes.set(binding.codexCallId, result.isError === true ? 'error' : 'success')
  }
  return outcomes
}

function object(value: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function opaque(value: JsonValue): PortableContentBlockV1 {
  return { kind: 'opaque', namespace: 'codex.responses.v1', value }
}

function extras(value: JsonObject, known: readonly string[]): PortableContentBlockV1[] {
  const retained = Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)))
  return Object.keys(retained).length === 0 ? [] : [opaque(retained)]
}

function textContent(value: JsonValue, expectedType: 'input_text' | 'output_text'): PortableContentBlockV1 {
  const content = object(value)
  if (content !== undefined && content.type === expectedType
    && typeof content.text === 'string' && Object.keys(content).every(key => key === 'type' || key === 'text')) {
    return { kind: 'text', text: content.text }
  }
  return opaque(value)
}

function outcomeContent(value: JsonValue): PortableContentBlockV1[] {
  if (typeof value === 'string') return [{ kind: 'text', text: value }]
  if (Array.isArray(value)) return value.map(part => textContent(part, 'input_text'))
  return [opaque(value)]
}

function responseContent(item: JsonObject, outcome?: ToolOutcome): {
  readonly role: PortableContextItemV1['role']
  readonly content: PortableContentBlockV1[]
} {
  switch (item.type) {
    case 'message': {
      const role = item.role
      if (typeof role !== 'string' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(role)
        || !Array.isArray(item.content)) break
      return {
        role: role as PortableContextItemV1['role'],
        content: [
          ...item.content.map(part => textContent(part, role === 'assistant' ? 'output_text' : 'input_text')),
          ...item.phase === undefined || item.phase === null ? [] : [opaque({ phase: item.phase })],
          ...extras(item, ['type', 'id', 'role', 'content', 'phase']),
        ],
      }
    }
    case 'reasoning': {
      if (!Array.isArray(item.summary) || (item.content !== undefined && item.content !== null && !Array.isArray(item.content))) break
      const parts = [...item.summary, ...Array.isArray(item.content) ? item.content : []]
      return {
        role: 'assistant',
        content: [
          ...parts.map((part): PortableContentBlockV1 => {
            const entry = object(part)
            return entry !== undefined && typeof entry.type === 'string'
              && ['summary_text', 'reasoning_text', 'text'].includes(entry.type)
              && typeof entry.text === 'string' && Object.keys(entry).every(key => key === 'type' || key === 'text')
              ? { kind: 'reasoning', text: entry.text }
              : opaque(part)
          }),
          opaque({ summary: item.summary, content: item.content ?? null }),
          ...item.encrypted_content === undefined || item.encrypted_content === null
            ? [] : [opaque({ encrypted_content: item.encrypted_content })],
          ...extras(item, ['type', 'id', 'summary', 'content', 'encrypted_content']),
        ],
      }
    }
    case 'function_call':
      if (typeof item.call_id === 'string' && item.call_id.length > 0
        && typeof item.name === 'string' && item.name.length > 0 && typeof item.arguments === 'string') {
        return { role: 'assistant', content: [
          { kind: 'tool-call', callId: item.call_id, name: item.name, arguments: item.arguments },
          ...extras(item, ['type', 'id', 'call_id', 'name', 'arguments']),
        ] }
      }
      break
    case 'function_call_output':
      if (typeof item.call_id === 'string' && item.call_id.length > 0
        && item.output !== undefined && outcome !== undefined) {
        return { role: 'tool', content: [
          { kind: 'tool-result', callId: item.call_id, content: outcomeContent(item.output), isError: outcome === 'error' },
          ...extras(item, ['type', 'id', 'call_id', 'output']),
        ] }
      }
      break
    default:
      break
  }
  return { role: item.type === 'function_call_output' ? 'tool' : 'assistant', content: [opaque(item)] }
}

/**
 * Preserve a checkpoint history item in the canonical DSH vocabulary.
 * Unknown Responses variants and fields stay namespaced opaque JSON, never
 * disappear. A tool result needs DSH's audited outcome; without it the raw
 * item stays opaque rather than inventing success.
 * @param envelope - validated JSON ResponseItemEnvelope from the V2 checkpoint.
 * @param index - stable position within the checkpoint's effective history.
 * @param outcome - audited success/error for a function-call result, if known.
 * @returns one canonical item with stable identity and lossless content.
 */
export function projectCodexResponseItem(
  envelope: JsonValue,
  index: number,
  outcome?: ToolOutcome,
): PortableContextItemV1 {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('Codex history index must be nonnegative')
  const wrapper = object(envelope)
  if (wrapper === undefined || wrapper.item === undefined) throw new TypeError('Codex history envelope has no Responses item')
  const item = object(wrapper.item)
  if (item === undefined) throw new TypeError('Codex history envelope has no Responses item')
  const projected = item.id !== undefined && item.id !== null && typeof item.id !== 'string'
    ? { role: 'assistant' as const, content: [opaque(item)] }
    : responseContent(item, outcome)
  const metadata = wrapper.metadata === undefined || wrapper.metadata === null ? [] : [opaque({ metadata: wrapper.metadata })]
  const wrapperExtras = extras(wrapper, ['item', 'metadata'])
  const sourceId = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined
  return {
    id: `codex:response:${index}`,
    role: projected.role,
    content: [...projected.content, ...metadata, ...wrapperExtras],
    provenance: {
      kind: projected.role === 'user' ? 'user'
        : projected.role === 'tool' ? 'tool'
          : projected.role === 'system' || projected.role === 'developer' ? 'instruction' : 'model',
      ...sourceId === undefined ? {} : { sourceId },
    },
  }
}

/**
 * Project exactly the model-visible history of one verified V2 checkpoint.
 * This is not a complete portable context: compacted predecessors and their
 * ancestry still require the rollout projection before the source port opens.
 * @param checkpoint - untrusted V2 checkpoint payload.
 * @param outcomes - committed DSH tool outcomes indexed by Codex call ID.
 * @returns ordered canonical items from the checkpoint's effective history.
 */
export function projectCodexEffectiveHistory(
  checkpoint: unknown,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): readonly PortableContextItemV1[] {
  if (!isCodexContextSnapshotV2(checkpoint)) throw new TypeError('Invalid Codex V2 checkpoint for portable history')
  return checkpoint.effectiveHistory.map((envelope, index) => projectEffectiveItem(envelope, index, outcomes))
}

function projectEffectiveItem(
  envelope: JsonValue,
  index: number,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): PortableContextItemV1 {
  const wrapper = object(envelope)
  const item = wrapper === undefined ? undefined : object(wrapper.item as JsonValue)
  const callId = item?.type === 'function_call_output' && typeof item.call_id === 'string'
    ? item.call_id : undefined
  return projectCodexResponseItem(envelope, index, callId === undefined ? undefined : outcomes.get(callId))
}

/** Project a validated active V2 history one item at a time while its source exists.
 * @param history - single-consumption effective-history values from a verified checkpoint.
 * @param outcomes - committed DSH outcomes keyed by Codex tool call ID.
 * @returns canonical active items in checkpoint order without a resident item array.
 */
export async function* projectCodexEffectiveHistoryStream(
  history: AsyncIterable<JsonValue>,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): AsyncGenerator<PortableContextItemV1> {
  let index = 0
  for await (const envelope of history) yield projectEffectiveItem(envelope, index++, outcomes)
}

/** Response history removed by compaction, with each installed replacement. */
export interface CodexPortableHistoricalItems {
  readonly items: readonly PortableContextItemV1[]
  readonly compactionOutputs: readonly { readonly id: string; readonly outputItemIds: readonly string[] }[]
}

/**
 * Preserve rollout Responses items and installed replacement histories without
 * treating non-history rollout events as model-visible messages or replaying them.
 * The V2 validator proves each replacement matches its durable rollout event.
 * @param checkpoint - untrusted V2 checkpoint payload.
 * @param outcomes - committed DSH tool outcomes indexed by Codex call ID.
 * @returns historical items and references to every compaction's outputs.
 */
export function projectCodexHistoricalItems(
  checkpoint: unknown,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): CodexPortableHistoricalItems {
  if (!isCodexContextSnapshotV2(checkpoint)) throw new TypeError('Invalid Codex V2 checkpoint for portable history')
  const items: PortableContextItemV1[] = []
  const compactionOutputs: { id: string; outputItemIds: string[] }[] = []
  let compactionIndex = 0
  const project = (envelope: JsonValue): PortableContextItemV1 => {
    const wrapper = object(envelope)
    const item = wrapper === undefined ? undefined : object(wrapper.item as JsonValue)
    const callId = item?.type === 'function_call_output' && typeof item.call_id === 'string'
      ? item.call_id : undefined
    const projected = projectCodexResponseItem(envelope, checkpoint.effectiveHistory.length + items.length,
      callId === undefined ? undefined : outcomes.get(callId))
    items.push(projected)
    return projected
  }
  for (const rolloutItem of checkpoint.rollout) {
    const entry = object(rolloutItem)
    if (entry?.type === 'response_item') {
      if (entry.payload === undefined) throw new TypeError('Codex rollout response item has no payload')
      project({ item: entry.payload, ...entry.metadata === undefined ? {} : { metadata: entry.metadata } })
    } else if (entry?.type === 'compacted') {
      const compaction = checkpoint.compactions[compactionIndex++]
      if (compaction === undefined) throw new Error('Codex compaction missing from verified checkpoint')
      const outputItemIds = compaction.replacementHistory.map(envelope => project(envelope).id)
      compactionOutputs.push({ id: compaction.id, outputItemIds })
    }
  }
  return { items, compactionOutputs }
}

/** Project verified rollout history without retaining every canonical item.
 * Compaction output references are delivered after their replacement items.
 * @param rollout - single-consumption verified V2 rollout items.
 * @param compactions - installed V2 compactions in checkpoint order.
 * @param activeItemCount - number of active items preceding historical IDs.
 * @param outcomes - committed tool results keyed by Codex call ID.
 * @param onCompaction - record output IDs needed by the ancestry projection.
 * @returns historical canonical items in rollout order.
 */
export async function* projectCodexHistoricalItemsStream(
  rollout: AsyncIterable<JsonValue>,
  compactions: AsyncIterable<JsonValue>,
  activeItemCount: number,
  outcomes: ReadonlyMap<string, ToolOutcome>,
  onCompaction: (output: { readonly id: string; readonly outputItemIds: readonly string[] }) => void,
): AsyncGenerator<PortableContextItemV1> {
  if (!Number.isSafeInteger(activeItemCount) || activeItemCount < 0) {
    throw new TypeError('Codex active item count must be nonnegative')
  }
  const compactionIterator = compactions[Symbol.asyncIterator]()
  let index = activeItemCount
  try {
    for await (const value of rollout) {
      const entry = object(value)
      if (entry?.type === 'response_item') {
        if (entry.payload === undefined) throw new TypeError('Codex rollout response item has no payload')
        yield projectEffectiveItem({ item: entry.payload,
          ...entry.metadata === undefined ? {} : { metadata: entry.metadata } }, index++, outcomes)
      } else if (entry?.type === 'compacted') {
        const next = await compactionIterator.next()
        const compaction = next.done ? undefined : object(next.value)
        if (compaction === undefined || typeof compaction.id !== 'string' || compaction.id.length === 0
          || !Array.isArray(compaction.replacementHistory)
          || !compaction.replacementHistory.every(isJsonValue)) {
          throw new Error('Codex compaction missing from verified checkpoint')
        }
        const outputItemIds: string[] = []
        for (const envelope of compaction.replacementHistory) {
          const item = projectEffectiveItem(envelope, index++, outcomes)
          outputItemIds.push(item.id)
          yield item
        }
        onCompaction({ id: compaction.id, outputItemIds })
      }
    }
    if (!(await compactionIterator.next()).done) {
      throw new Error('Codex checkpoint has an extra compaction without rollout installation')
    }
  } finally {
    await compactionIterator.return?.()
  }
}
