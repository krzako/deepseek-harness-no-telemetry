import { describe, expect, it } from 'vitest'
import { parseCodexAuditEventV1 } from '../src/audit-contract.ts'

const base = {
  version: 1, sequence: 1, eventId: 'event-1', time: 1, threadId: 'thread-1', turn: 0,
  codexTurnId: 'turn-1',
} as const
const inline = { kind: 'inline', value: { secret: 'pełna treść bez redakcji' } } as const
const artifact = { kind: 'artifact', sha256: 'a'.repeat(64), bytes: 1_000_000,
  mediaType: 'application/json' } as const
const model = { ...base, attemptId: 'attempt-1', purpose: 'inference' } as const
const tool = { ...base, codexCallId: 'call-1' } as const
const compaction = { ...base, compactionId: 'compact-1' } as const

describe('Codex durable audit event contract', () => {
  it('accepts every versioned model, tool, compaction, config, and checkpoint fact', () => {
    const events = [
      { ...model, kind: 'model/request', stage: 'model-visible', apiFormat: 'responses', request: inline },
      { ...model, kind: 'model/stream', stage: 'upstream', index: 0, chunk: artifact },
      { ...model, kind: 'model/result', stage: 'codex', result: inline },
      { ...model, kind: 'model/failure', stage: 'upstream', code: 'HTTP_503', message: 'unavailable', details: inline },
      { ...tool, kind: 'tool/request', name: 'dsh_lookup', arguments: inline },
      { ...tool, kind: 'tool/approval', decision: 'denied', request: inline, response: inline },
      { ...tool, kind: 'tool/result', outcome: 'error', result: inline },
      { ...compaction, kind: 'compaction/request', reason: 'threshold', inputHistory: artifact, prompt: inline },
      { ...compaction, kind: 'compaction/result', result: artifact },
      { ...compaction, kind: 'compaction/pending', effectiveHistory: artifact,
        priorRolloutSha256: 'c'.repeat(64) },
      { ...compaction, kind: 'compaction/installed', effectiveHistory: artifact },
      { ...compaction, kind: 'compaction/aborted', effectiveHistory: artifact, reason: 'rollout unchanged' },
      { ...compaction, kind: 'compaction/failure', message: 'interrupted' },
      { ...base, kind: 'context/config', config: inline },
      { ...base, kind: 'checkpoint', checkpointId: 'snapshot-1', snapshot: artifact,
        effectiveHistorySha256: 'b'.repeat(64) },
    ]
    expect(events.map(event => parseCodexAuditEventV1(event).kind)).toEqual(events.map(event => event.kind))
    expect(parseCodexAuditEventV1(events[0])).toEqual(events[0])
  })

  it('rejects version drift, missing identity, invalid JSON, and unverified artifact metadata', () => {
    const request = { ...model, kind: 'model/request', stage: 'model-visible',
      apiFormat: 'responses', request: inline }
    for (const invalid of [
      { ...request, version: 2 },
      { ...request, sequence: 0 },
      { ...request, eventId: '' },
      { ...request, request: { kind: 'inline', value: { lost: undefined } } },
      { ...request, request: { ...artifact, sha256: 'not-a-hash' } },
      { ...request, request: { ...artifact, path: '../../escape' } },
      { ...request, stage: 'unknown' },
      { ...request, extra: 'unversioned data' },
    ]) expect(() => parseCodexAuditEventV1(invalid)).toThrow()
  })

  it('accepts legacy pending without a rollout anchor but rejects a malformed anchor', () => {
    const pending = { ...compaction, kind: 'compaction/pending', effectiveHistory: inline }
    expect(parseCodexAuditEventV1(pending)).toEqual(pending)
    expect(() => parseCodexAuditEventV1({ ...pending, priorRolloutSha256: 'invalid' })).toThrow()
  })
})
