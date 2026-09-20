import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { codexThreadBindingProjectionDefinition } from '../src/index.ts'
import type { CodexThreadBinding } from '../src/index.ts'

const first: CodexThreadBinding = {
  version: 1,
  threadId: 'codex-thread-1' as CodexThreadBinding['threadId'],
  runtimeVersion: '0.149.1',
  cwd: '/workspace',
}

function project(session: Session) {
  return session.snapshotEvents().reduce(
    codexThreadBindingProjectionDefinition.apply,
    codexThreadBindingProjectionDefinition.init(),
  )
}

describe('Codex thread binding projection', () => {
  it('retains one repeated binding without a conflict', () => {
    const session = Session.create(SessionId('dsh-session'))
    const event = session.append('codex/thread-bound', first)
    const state = codexThreadBindingProjectionDefinition.apply(
      codexThreadBindingProjectionDefinition.init(),
      event,
    )
    expect(codexThreadBindingProjectionDefinition.apply(state, event)).toEqual({
      binding: first,
      conflict: null,
    })
  })

  it('retains the original binding and diagnoses a different thread', () => {
    const session = Session.create(SessionId('dsh-session'))
    const initial = session.append('codex/thread-bound', first)
    const replacement = session.append('codex/thread-bound', {
      ...first,
      threadId: 'codex-thread-2' as CodexThreadBinding['threadId'],
    })
    const state = codexThreadBindingProjectionDefinition.apply(
      codexThreadBindingProjectionDefinition.apply(
        codexThreadBindingProjectionDefinition.init(),
        initial,
      ),
      replacement,
    )
    expect(state).toEqual({
      binding: first,
      conflict: 'session binds Codex threads "codex-thread-1" and "codex-thread-2"',
    })
  })

  it('serializes every Codex event and replays the durable thread binding', () => {
    const original = Session.create(SessionId('dsh-session'))
    original.append('codex/thread-bound', first)
    original.append('codex/turn-bound', {
      version: 1,
      turn: 1,
      codexTurnId: 'codex-turn-1' as never,
    })
    for (const phase of ['started', 'updated', 'completed'] as const) {
      original.append(`codex/item/${phase}`, {
        version: 1,
        turn: 1,
        codexTurnId: 'codex-turn-1' as never,
        itemId: 'item-1',
        itemType: 'agentMessage',
        item: { id: 'item-1', type: 'agentMessage', text: 'done' },
      })
    }
    original.append('codex/usage', {
      version: 1,
      turn: 1,
      inputTokens: 10,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 1,
    })
    original.append('codex/error', {
      version: 1,
      turn: 1,
      stage: 'turn',
      message: 'safe diagnostic',
      code: 'test',
    })

    const decoded: unknown = JSON.parse(JSON.stringify(original.snapshotEvents()))
    if (!Array.isArray(decoded)) throw new TypeError('serialized events must be an array')
    const wire = decoded as SessionEvent[]
    const replayed = Session.create(SessionId('dsh-session-replay'), wire)

    expect(project(replayed)).toEqual({ binding: first, conflict: null })
    expect(replayed.snapshotEvents().slice(0, wire.length)).toEqual(wire)
  })
})
