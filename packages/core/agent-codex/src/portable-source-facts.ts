/** Select one completed Codex Session checkpoint without reading artifact bytes. */

import { isDeepStrictEqual } from 'node:util'
import { isAgentDriverStateV1, type AgentDriverStateV1 } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { parseCodexAuditEventV1, type CodexAuditEventV1 } from './audit-contract.ts'
import { codexGatewayModelId } from './model-gateway.ts'
import type { CodexThreadBinding } from './types.ts'

/** Committed facts that must be resolved behind the same durable read barrier. */
export interface CodexPortableSourceFacts {
  readonly binding: CodexThreadBinding
  readonly turn: number
  readonly audit: readonly CodexAuditEventV1[]
  readonly checkpoint: Extract<CodexAuditEventV1, { readonly kind: 'checkpoint' }>
  readonly preceding: readonly CodexAuditEventV1[]
}

/**
 * Select the final checkpoint of the last successfully completed Codex turn.
 * The caller supplies a flushed or detached durable Session; no live Codex
 * process is queried and an incomplete audit never becomes portable state.
 * @param session - one complete Session read at a completed-turn boundary.
 * @returns ordered audit and its final checkpoint fact for artifact resolution.
 */
export function selectCodexPortableSourceFacts(session: Session): CodexPortableSourceFacts {
  const events = session.snapshotEvents()
  const selections = events.filter(event => event.type === 'agent/driver-selected')
  if (selections.length !== 1 || selections[0]?.data.driverId !== 'codex') {
    throw new Error('Codex portable source requires one committed codex driver selection')
  }
  const bindings = events.filter(event => event.type === 'codex/thread-bound')
  const binding = bindings[0]?.data
  if (binding === undefined || bindings.length !== 1) throw new Error('Codex portable source has no unique thread binding')
  let openTurn: number | undefined
  let lastTurn: number | undefined
  let lastCompleted = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (openTurn !== undefined) throw new Error('Codex portable source has overlapping turns')
      openTurn = event.data.turn
    } else if (event.type === 'turn/end') {
      if (openTurn !== event.data.turn) throw new Error('Codex portable source has an unmatched turn end')
      lastTurn = event.data.turn
      lastCompleted = event.data.reason.kind === 'completed'
      openTurn = undefined
    }
  }
  if (openTurn !== undefined || lastTurn === undefined) {
    throw new Error('Codex portable source has no completed turn boundary')
  }
  if (!lastCompleted) throw new Error('Codex portable source last turn did not complete successfully')
  const turnBindings = events.filter(event => event.type === 'codex/turn-bound' && event.data.turn === lastTurn)
  const turnBinding = turnBindings[0]
  if (turnBindings.length !== 1 || turnBinding?.type !== 'codex/turn-bound') {
    throw new Error('Codex portable source has no unique final turn binding')
  }
  const codexTurnId = turnBinding.data.codexTurnId
  const audit: CodexAuditEventV1[] = []
  const eventIds = new Set<string>()
  let pending: Extract<CodexAuditEventV1, { readonly kind: 'compaction/pending' }> | undefined
  for (const event of events) {
    if (event.type !== 'codex/audit-v1') continue
    const fact = parseCodexAuditEventV1(event.data)
    if (fact.threadId !== binding.threadId || fact.sequence !== audit.length + 1 || eventIds.has(fact.eventId)) {
      throw new Error('Codex portable source audit has thread, sequence, or event ID conflict')
    }
    if (pending !== undefined) {
      if ((fact.kind !== 'compaction/installed' && fact.kind !== 'compaction/aborted')
        || fact.compactionId !== pending.compactionId
        || !isDeepStrictEqual(fact.effectiveHistory, pending.effectiveHistory)) {
        throw new Error(`Codex portable source compaction ${pending.compactionId} is unresolved`)
      }
      pending = undefined
    } else if (fact.kind === 'compaction/pending') {
      pending = fact
    } else if (fact.kind === 'compaction/installed' || fact.kind === 'compaction/aborted') {
      throw new Error(`Codex portable source compaction ${fact.compactionId} has no pending fact`)
    }
    eventIds.add(fact.eventId)
    audit.push(fact)
  }
  if (pending !== undefined) throw new Error(`Codex portable source compaction ${pending.compactionId} is unresolved`)
  const tail = audit.at(-1)
  if (tail?.kind !== 'checkpoint' || tail.turn !== lastTurn
    || tail.codexTurnId !== codexTurnId || tail.checkpointId !== `turn:${codexTurnId}`) {
    throw new Error('Codex portable source has no final checkpoint for its last completed turn')
  }
  return { binding, turn: lastTurn, audit, checkpoint: tail, preceding: audit.slice(0, -1) }
}

/**
 * Record the last completed Codex model route from durable execution facts,
 * never from the destination's current settings catalog. Prefer inference to
 * a compaction-only route when both ran in the same turn.
 * @param session - same complete durable Session used to select the checkpoint.
 * @param facts - selected final checkpoint and its owning Codex thread.
 * @returns portable driver/model identity including any imported lineage.
 */
export function codexPortableDriverState(session: Session, facts: CodexPortableSourceFacts): AgentDriverStateV1 {
  const events = session.snapshotEvents()
  const checkpointEvent = events.find(event => event.type === 'codex/audit-v1'
    && event.data.eventId === facts.checkpoint.eventId)
  if (checkpointEvent?.type !== 'codex/audit-v1' || !isDeepStrictEqual(checkpointEvent.data, facts.checkpoint)) {
    throw new Error('Codex portable source checkpoint differs from its Session')
  }
  const requests = events.filter(event => event.type === 'codex/model-audit'
    && event.data.turn === facts.turn && event.data.phase === 'upstream-request')
  if (requests.some(event => event.seq >= checkpointEvent.seq)) {
    throw new Error('Codex portable source model route was written after its final checkpoint')
  }
  const selected = requests.findLast(event => event.type === 'codex/model-audit' && event.data.purpose === 'inference')
    ?? requests.at(-1)
  if (selected?.type !== 'codex/model-audit') {
    throw new Error('Codex portable source has no audited upstream model route')
  }
  const payload = selected.data.payload
  const route = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.route : undefined
  if (route === undefined || route === null || typeof route !== 'object' || Array.isArray(route)
    || typeof route.provider !== 'string' || route.provider.length === 0
    || typeof route.model !== 'string' || route.model.length === 0
    || (route.apiFormat !== 'chat-completions' && route.apiFormat !== 'responses')) {
    throw new Error('Codex portable source has an invalid audited upstream model route')
  }
  const state: AgentDriverStateV1 = {
    version: 1,
    sessionId: session.id,
    driver: { id: 'codex', version: facts.binding.runtimeVersion },
    model: { provider: `codex:${route.provider}`, id: codexGatewayModelId(route.provider, route.model) },
    ...session.header.importLineage === undefined ? {} : { lineage: session.header.importLineage },
  }
  if (!isAgentDriverStateV1(state)) throw new Error('Codex portable source produced invalid driver state')
  return state
}
