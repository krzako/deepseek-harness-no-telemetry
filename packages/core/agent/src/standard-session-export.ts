/** Project a completed standard Session into the shared portable context. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface, isSurfaceEvent, type Session } from '@deepseek-ai/dsh-session'
import {
  isPortableAgentContextV1,
  PORTABLE_AGENT_VERSION,
  type AgentDriverStateV1,
  type PortableAgentContextV1,
  type PortableAgentContextStreamV1,
  type PortableCompactionV1,
  type PortableContentBlockV1,
  type PortableContextItemV1,
} from './portable-session.ts'

function blocks(content: readonly ContentBlock[]): PortableContentBlockV1[] {
  return content.map<PortableContentBlockV1>((block) => {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return { kind: block.type, text: block.text }
      case 'image':
        return {
          kind: 'attachment', attachmentId: block.attachment.attachmentId,
          mediaType: block.attachment.mediaType,
          ...block.attachment.name === undefined ? {} : { name: block.attachment.name },
        }
      case 'file':
        return {
          kind: 'attachment', attachmentId: block.attachment.attachmentId,
          mediaType: 'application/octet-stream', name: block.attachment.name,
        }
      case 'tool-call':
        return { kind: 'tool-call', callId: block.id, name: block.name, arguments: block.arguments }
      case 'tool-result':
        return {
          kind: 'tool-result', callId: block.toolCallId,
          content: blocks(block.content), isError: block.isError === true,
        }
      default:
        throw new Error(`standard Session contains an unsupported content block: ${String((block as { type?: unknown }).type)}`)
    }
  })
}

/** Capture a completed event snapshot and its effective item references. */
function prepareStandardSession(session: Session): {
  source: AgentDriverStateV1
  items: () => Generator<PortableContextItemV1>
  effectiveItemIds: readonly string[]
  compactions: readonly PortableCompactionV1[]
} {
  const events = session.snapshotEvents()
  let openTurn: number | undefined
  let openCompaction = false
  let header: Extract<typeof events[number], { type: 'request/header' }> | undefined
  let systemId: string | undefined
  const itemIdBySeq = new Map<number, string>()
  for (const event of events) {
    const eventType: string = event.type
    if (eventType === 'compaction/start') {
      if (openCompaction) throw new Error('standard Session has overlapping compactions')
      openCompaction = true
    } else if (eventType === 'compaction/end') {
      if (!openCompaction) throw new Error('standard Session has an unmatched compaction end')
      openCompaction = false
    } else if (event.type === 'agent/driver-selected' && event.data.driverId !== 'standard') {
      throw new Error(`Session belongs to ${event.data.driverId}, not the standard driver`)
    }
    if (event.type === 'turn/start') {
      if (openTurn !== undefined) throw new Error('standard Session has overlapping turns')
      openTurn = event.data.turn
    } else if (event.type === 'turn/end') {
      if (openTurn !== event.data.turn) throw new Error('standard Session has an unmatched turn end')
      openTurn = undefined
    } else if (event.type === 'request/header') {
      header = event
      systemId = undefined
      if (event.data.header.system !== undefined) {
        systemId = `standard:system:${event.seq}`
      }
    }
    if (!isSurfaceEvent(event)) continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    const id = `standard:event:${event.seq}`
    itemIdBySeq.set(event.seq, id)
  }
  if (openTurn !== undefined) throw new Error(`standard Session turn ${openTurn} is active`)
  if (openCompaction) throw new Error('standard Session compaction is active')
  if (header === undefined) throw new Error('standard Session has no request header')
  const surface = foldSurface(events)
  const itemIds = (seqs: readonly number[]): string[] => seqs.flatMap((seq) => {
    const id = itemIdBySeq.get(seq)
    return id === undefined ? [] : [id]
  })
  const capturedHeader = header
  return {
    source: { version: PORTABLE_AGENT_VERSION, sessionId: session.id,
      driver: { id: 'standard', version: '1' },
      model: { provider: capturedHeader.data.header.config.provider, id: capturedHeader.data.header.config.model },
      ...session.header.importLineage === undefined ? {} : { lineage: session.header.importLineage } },
    *items() {
      for (const event of events) {
        if (event.type === 'request/header' && event.data.header.system !== undefined) {
          yield { id: `standard:system:${event.seq}`, role: 'system',
            content: [{ kind: 'text', text: event.data.header.system }],
            provenance: { kind: 'instruction', sourceId: String(event.seq) } }
        }
        if (!isSurfaceEvent(event)) continue
        const message = deriveEventMessage(event)
        if (message === null) continue
        const provenance = event.type === 'tool/result'
          ? { kind: 'tool' as const, sourceId: String(event.seq) }
          : event.type === 'assistant/message'
            ? { kind: 'model' as const, sourceId: String(event.seq) }
            : event.surfaceOp === 'append'
              ? { kind: 'user' as const, sourceId: String(event.seq) }
              : { kind: 'compaction' as const, sourceId: String(event.seq) }
        yield { id: `standard:event:${event.seq}`, role: event.type === 'tool/result' ? 'tool' : message.role,
          content: blocks(message.content), provenance }
      }
    },
    effectiveItemIds: [
      ...systemId === undefined ? [] : [systemId],
      ...itemIds(surface.nodes),
    ],
    compactions: surface.replacements.map(replacement => ({
      id: `standard:replacement:${replacement.seq}`,
      mode: 'local',
      inputItemIds: itemIds(replacement.shadowedSeqs),
      outputItemIds: itemIds([replacement.seq]),
      promptItemIds: [],
      resultItemIds: itemIds([replacement.seq]),
    })),
  }
}

function asAsync<T>(iterator: Iterator<T>): AsyncIterable<T> {
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve(iterator.next()) }) }
}

/**
 * Export logged model-visible history without running a model or replaying tools.
 * A caller must attach immutable bytes for every referenced attachment before
 * publishing an archive. Active turns and unsupported content fail explicitly.
 * @param session - standard driver's durable Session at a turn boundary.
 * @returns the complete portable message history and effective projection.
 */
export function projectStandardSession(session: Session): PortableAgentContextV1 {
  const prepared = prepareStandardSession(session)
  const context: PortableAgentContextV1 = {
    version: PORTABLE_AGENT_VERSION, source: prepared.source,
    items: [...prepared.items()], effectiveItemIds: prepared.effectiveItemIds,
    compactions: prepared.compactions,
  }
  if (!isPortableAgentContextV1(context)) throw new Error('standard Session produced invalid portable context')
  return context
}

/** Project a stable Session snapshot one canonical item at a time for ZIP export.
 * The source Session may append after this call; yielded events remain frozen.
 * @param session - standard driver's completed durable Session.
 * @returns single-use context iterables without a projected item array.
 */
export function projectStandardSessionStream(session: Session): PortableAgentContextStreamV1 {
  const prepared = prepareStandardSession(session)
  return {
    version: PORTABLE_AGENT_VERSION, source: prepared.source,
    items: asAsync(prepared.items()),
    effectiveItemIds: asAsync(prepared.effectiveItemIds.values()),
    compactions: asAsync(prepared.compactions.values()),
  }
}
