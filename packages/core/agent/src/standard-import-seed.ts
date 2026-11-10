/** Build a new standard Session seed from prepared portable messages. */

import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { StandardImportEntry } from './standard-session-import.ts'
import type { StandardImportPreparation } from './standard-transfer-ports.ts'

/** Import facts ready for the Session factory and separate instruction assembly. */
export interface StandardImportSeed {
  readonly events: readonly SessionEvent[]
  readonly instructions: readonly Extract<StandardImportEntry, { kind: 'instruction' }>[]
  /** Exact source system text for a same-driver import, including the empty prompt. */
  readonly systemInstruction?: string
}

function sameDriverSystemInstruction(preparation: StandardImportPreparation): string | undefined {
  if (preparation.context.source.driver.id !== 'standard') return undefined
  const instructions = preparation.projection.entries.filter(entry => entry.kind === 'instruction')
  if (instructions.length === 0) return ''
  const [instruction] = instructions
  const [block] = instruction?.content ?? []
  if (instructions.length !== 1 || instruction?.role !== 'system'
    || instruction.content.length !== 1 || block?.type !== 'text') {
    throw new Error('standard same-driver import requires one plain-text system instruction')
  }
  return block.text
}

/**
 * Construct a balanced synthetic history for a fresh standard Session.
 * Historical calls are recorded, never executed. The caller must install the
 * separately returned instructions through its own prompt composition before
 * publishing the Session; otherwise it must reject the import. For a standard
 * source, the exact system text is also retained in the initial request header
 * so a later resume can reconstruct the scoped literal prompt.
 * @param preparation - validated standard target-port result.
 * @returns replay-valid event seed and ordered instruction entries.
 */
export function buildStandardImportSeed(preparation: StandardImportPreparation): StandardImportSeed {
  const systemInstruction = sameDriverSystemInstruction(preparation)
  const session = Session.create(preparation.targetSessionId)
  session.append('agent/driver-selected', { version: 1, driverId: 'standard' })
  const instructions: Extract<StandardImportEntry, { kind: 'instruction' }>[] = []
  let turn = 0
  let open = false
  let assistantEntered = false
  const pending = new Set<string>()
  const start = (): void => {
    if (open) return
    turn++
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    open = true
    assistantEntered = false
  }
  const end = (): void => {
    if (!open) return
    if (pending.size > 0) throw new Error(`standard import has unresolved tool calls in turn ${turn}`)
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    open = false
  }
  start()
  session.append('request/header', {
    reason: 'initial', header: {
      config: { provider: preparation.targetModel.provider, model: preparation.targetModel.id },
      ...systemInstruction === undefined ? {} : { system: systemInstruction },
    },
  })
  for (const entry of preparation.projection.entries) {
    if (entry.kind === 'instruction') {
      instructions.push(entry)
      continue
    }
    const message = entry.message
    if (message.source.kind === 'tool') {
      if (!pending.delete(message.source.callId)) {
        throw new Error(`standard import tool result ${message.source.callId} has no pending call`)
      }
      const result = message.content[0]
      if (message.role !== 'user' || message.content.length !== 1 || result?.type !== 'tool-result') {
        throw new Error(`standard import tool result ${message.source.callId} has invalid content`)
      }
      session.append('tool/result', {
        turn, step: 1,
        message: {
          id: message.id, role: 'user', source: { kind: 'tool', callId: message.source.callId },
          content: [result],
        },
      }, { surfaceOp: 'append' })
      if (pending.size === 0) end()
      continue
    }
    if (message.role === 'user') {
      if (assistantEntered) end()
      start()
      session.append('user/message', {
        id: message.id, role: 'user', source: message.source, content: message.content,
      }, { surfaceOp: 'append' })
      continue
    }
    if (message.role !== 'assistant' || message.source.kind !== 'model') {
      throw new Error(`standard import message ${entry.sourceItemId} has unsupported role or source`)
    }
    if (assistantEntered) end()
    start()
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: { id: message.id, role: 'assistant', source: message.source, content: message.content },
    }, { surfaceOp: 'append' })
    assistantEntered = true
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      if (pending.has(block.id)) throw new Error(`standard import duplicated tool call ${block.id}`)
      pending.add(block.id)
      session.append('tool/call', {
        turn, step: 1, callId: block.id, name: block.name, arguments: block.arguments,
      })
    }
    if (pending.size === 0) end()
  }
  end()
  const events = session.snapshotEvents()
  Session.create(preparation.targetSessionId, events)
  return {
    events,
    instructions: Object.freeze([...instructions]),
    ...systemInstruction === undefined ? {} : { systemInstruction },
  }
}
