import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { parseCodexAuditEventV1 } from '../src/audit-contract.ts'
import { codexPortableDriverState, selectCodexPortableSourceFacts } from '../src/portable-source-facts.ts'

function config(sequence: number, threadId = 'thread-1', eventId = `event-${sequence}`, turn = 1) {
  return parseCodexAuditEventV1({ version: 1, sequence, eventId, time: sequence, threadId,
    turn, kind: 'context/config', config: { kind: 'inline', value: { schemaVersion: 1 } } })
}

function checkpoint(sequence: number, checkpointId = 'turn:turn-1', eventId = `event-${sequence}`, turn = 1) {
  return parseCodexAuditEventV1({ version: 1, sequence, eventId, time: sequence,
    threadId: 'thread-1', turn, codexTurnId: `turn-${turn}`, kind: 'checkpoint', checkpointId,
    snapshot: { kind: 'artifact', sha256: 'a'.repeat(64), bytes: 12, mediaType: 'application/json' },
    effectiveHistorySha256: 'b'.repeat(64) })
}

function modelAudit(turn: number, provider: string, model: string) {
  return { version: 1 as const, turn, attemptId: `attempt-${turn}`, purpose: 'inference' as const,
    phase: 'upstream-request' as const, payload: { route: { provider, model, apiFormat: 'chat-completions' } } }
}

function session(): Session {
  const result = Session.create(SessionId('codex-portable-facts'))
  result.append('agent/driver-selected', { version: 1, driverId: 'codex' })
  result.append('codex/thread-bound', { version: 1, threadId: 'thread-1' as never,
    runtimeVersion: 'fork-abc', cwd: '/workspace' })
  result.append('turn/start', { turn: 1 })
  result.append('codex/turn-bound', { version: 1, turn: 1, codexTurnId: 'turn-1' as never })
  result.append('codex/model-audit', modelAudit(1, 'llm_proxy', 'glm-5'))
  result.append('codex/audit-v1', config(1))
  result.append('codex/audit-v1', checkpoint(2))
  result.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return result
}

describe('Codex portable source checkpoint selection', () => {
  it('selects the final checkpoint and ordered facts of the last completed turn', () => {
    const facts = selectCodexPortableSourceFacts(session())
    expect(facts.binding.threadId).toBe('thread-1')
    expect(facts.turn).toBe(1)
    expect(facts.audit).toEqual([config(1), checkpoint(2)])
    expect(facts.checkpoint).toEqual(checkpoint(2))
    expect(facts.preceding).toEqual([config(1)])
  })

  it('refuses active, failed, or uncheckpointed final turns', () => {
    const active = session()
    active.append('turn/start', { turn: 2 })
    expect(() => selectCodexPortableSourceFacts(active)).toThrow('no completed turn boundary')
    const failed = session()
    failed.append('turn/start', { turn: 2 })
    failed.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(() => selectCodexPortableSourceFacts(failed)).toThrow('did not complete successfully')
    const missing = session()
    missing.append('turn/start', { turn: 2 })
    missing.append('codex/turn-bound', { version: 1, turn: 2, codexTurnId: 'turn-2' as never })
    missing.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(() => selectCodexPortableSourceFacts(missing)).toThrow('no final checkpoint')
  })

  it('refuses wrong thread, sequence gap, repeated ID, and wrong checkpoint identity', () => {
    const wrongThread = session()
    wrongThread.append('codex/audit-v1', config(3, 'other-thread'))
    expect(() => selectCodexPortableSourceFacts(wrongThread)).toThrow('thread, sequence, or event ID conflict')
    const gap = session()
    gap.append('codex/audit-v1', config(4))
    expect(() => selectCodexPortableSourceFacts(gap)).toThrow('thread, sequence, or event ID conflict')
    const duplicate = session()
    duplicate.append('codex/audit-v1', config(3, 'thread-1', 'event-1'))
    expect(() => selectCodexPortableSourceFacts(duplicate)).toThrow('thread, sequence, or event ID conflict')
    const wrongCheckpoint = Session.create(SessionId('wrong-checkpoint'))
    wrongCheckpoint.append('agent/driver-selected', { version: 1, driverId: 'codex' })
    wrongCheckpoint.append('codex/thread-bound', { version: 1, threadId: 'thread-1' as never,
      runtimeVersion: 'fork-abc', cwd: '/workspace' })
    wrongCheckpoint.append('turn/start', { turn: 1 })
    wrongCheckpoint.append('codex/turn-bound', { version: 1, turn: 1, codexTurnId: 'turn-1' as never })
    wrongCheckpoint.append('codex/audit-v1', checkpoint(1, 'compaction:wrong'))
    wrongCheckpoint.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => selectCodexPortableSourceFacts(wrongCheckpoint)).toThrow('no final checkpoint')
  })

  it('refuses pending compaction even if a later checkpoint is present', () => {
    const result = Session.create(SessionId('pending-compaction'))
    result.append('agent/driver-selected', { version: 1, driverId: 'codex' })
    result.append('codex/thread-bound', { version: 1, threadId: 'thread-1' as never,
      runtimeVersion: 'fork-abc', cwd: '/workspace' })
    result.append('turn/start', { turn: 1 })
    result.append('codex/turn-bound', { version: 1, turn: 1, codexTurnId: 'turn-1' as never })
    result.append('codex/audit-v1', parseCodexAuditEventV1({ version: 1, sequence: 1,
      eventId: 'pending-1', time: 1, threadId: 'thread-1', turn: 1, kind: 'compaction/pending',
      compactionId: 'compact-1', effectiveHistory: { kind: 'inline', value: [] },
      priorRolloutSha256: 'c'.repeat(64) }))
    result.append('codex/audit-v1', checkpoint(2))
    result.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => selectCodexPortableSourceFacts(result)).toThrow('is unresolved')
  })

  it('derives the last turn model and source lineage from durable facts, not settings', () => {
    const result = session()
    result.append('turn/start', { turn: 2 })
    result.append('codex/turn-bound', { version: 1, turn: 2, codexTurnId: 'turn-2' as never })
    result.append('codex/model-audit', modelAudit(2, 'copilot_proxy', 'new/model'))
    result.append('codex/audit-v1', config(3, 'thread-1', 'event-3', 2))
    result.append('codex/audit-v1', checkpoint(4, 'turn:turn-2', 'event-4', 2))
    result.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(codexPortableDriverState(result, selectCodexPortableSourceFacts(result))).toEqual({
      version: 1, sessionId: result.id, driver: { id: 'codex', version: 'fork-abc' },
      model: { provider: 'codex:copilot_proxy', id: 'copilot_proxy/new%2Fmodel' },
    })
  })

  it('refuses missing or malformed persisted model routes', () => {
    const missing = Session.create(SessionId('model-route-missing'))
    missing.append('agent/driver-selected', { version: 1, driverId: 'codex' })
    missing.append('codex/thread-bound', { version: 1, threadId: 'thread-1' as never,
      runtimeVersion: 'fork-abc', cwd: '/workspace' })
    missing.append('turn/start', { turn: 1 })
    missing.append('codex/turn-bound', { version: 1, turn: 1, codexTurnId: 'turn-1' as never })
    missing.append('codex/audit-v1', checkpoint(1))
    missing.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => codexPortableDriverState(missing, selectCodexPortableSourceFacts(missing)))
      .toThrow('no audited upstream model route')
    const malformed = Session.create(SessionId('model-route-malformed'))
    malformed.append('agent/driver-selected', { version: 1, driverId: 'codex' })
    malformed.append('codex/thread-bound', { version: 1, threadId: 'thread-1' as never,
      runtimeVersion: 'fork-abc', cwd: '/workspace' })
    malformed.append('turn/start', { turn: 1 })
    malformed.append('codex/turn-bound', { version: 1, turn: 1, codexTurnId: 'turn-1' as never })
    malformed.append('codex/model-audit', { ...modelAudit(1, 'llm_proxy', 'glm-5'),
      payload: { route: { provider: 'llm_proxy', model: '', apiFormat: 'responses' } } })
    malformed.append('codex/audit-v1', checkpoint(1))
    malformed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => codexPortableDriverState(malformed, selectCodexPortableSourceFacts(malformed)))
      .toThrow('invalid audited upstream model route')
    const outOfOrder = session()
    outOfOrder.append('codex/model-audit', modelAudit(1, 'llm_proxy', 'late'))
    expect(() => codexPortableDriverState(outOfOrder, selectCodexPortableSourceFacts(outOfOrder)))
      .toThrow('written after its final checkpoint')
  })
})
