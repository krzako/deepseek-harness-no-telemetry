import { describe, expect, it } from 'vitest'
import {
  agentDriverThreadId,
  agentDriverTurnId,
  agentTraceStepId,
  agentTraceTurnId,
  assertAgentTraceContinuation,
  AGENT_TRACE_CORRELATION_VERSION,
  type AgentTraceCorrelationV1,
} from '@deepseek-ai/dsh-agent'
import { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'

function modelAttempt(attempt: string): AgentTraceCorrelationV1 {
  const sessionId = SessionId('session-1')
  const turnId = agentTraceTurnId(sessionId, 3)
  return {
    version: AGENT_TRACE_CORRELATION_VERSION,
    sessionId,
    driverId: 'codex',
    threadId: agentDriverThreadId('thread-1'),
    driverTurnId: agentDriverTurnId('driver-turn-1'),
    turn: 3,
    step: 2,
    turnId,
    stepId: agentTraceStepId(turnId, 2),
    kind: 'model-attempt',
    modelAttemptId: LlmAttemptId(attempt),
  }
}

describe('Agent trace correlation', () => {
  it('retains the DSH step while giving every retried provider request a new attempt id', () => {
    const first = modelAttempt('attempt-1')
    const retry = modelAttempt('attempt-2')
    expect(() => { assertAgentTraceContinuation(first, retry, 'retry') }).not.toThrow()
    expect(() => { assertAgentTraceContinuation(first, first, 'retry') })
      .toThrow('model retry reused its attempt id')
    expect(retry.turnId).toBe(first.turnId)
    expect(retry.stepId).toBe(first.stepId)
  })

  it('reuses the attempt id when reconnecting to the same provider request', () => {
    const first = modelAttempt('attempt-1')
    expect(() => { assertAgentTraceContinuation(first, modelAttempt('attempt-1'), 'reconnect') })
      .not.toThrow()
    expect(() => { assertAgentTraceContinuation(first, modelAttempt('attempt-2'), 'reconnect') })
      .toThrow('model reconnect changed its attempt id')
  })

  it('refuses reconnect into a different session, driver, thread, turn, or step', () => {
    const first = modelAttempt('attempt-1')
    const different = [
      { ...first, sessionId: SessionId('session-2') },
      { ...first, driverId: 'standard' },
      { ...first, threadId: agentDriverThreadId('thread-2') },
      { ...first, driverTurnId: agentDriverTurnId('driver-turn-2') },
      { ...first, turn: 4 },
      { ...first, step: 3 },
      { ...first, turnId: agentTraceTurnId(first.sessionId, 4) },
      { ...first, stepId: agentTraceStepId(first.turnId, 3) },
    ] satisfies AgentTraceCorrelationV1[]
    for (const candidate of different) {
      expect(() => { assertAgentTraceContinuation(first, candidate, 'reconnect') })
        .toThrow('agent trace continuation changed its step identity')
    }
  })

  it('preserves tool-call identity on reconnect and refuses implicit tool retry', () => {
    const { modelAttemptId: _attempt, ...scope } = modelAttempt('attempt-1')
    const first: AgentTraceCorrelationV1 = { ...scope, kind: 'tool-call', toolCallId: ToolCallId('call-1') }
    expect(() => { assertAgentTraceContinuation(first, { ...first }, 'reconnect') }).not.toThrow()
    expect(() => {
      assertAgentTraceContinuation(first, { ...first, toolCallId: ToolCallId('call-2') }, 'reconnect')
    }).toThrow('tool reconnect changed its call id')
    expect(() => { assertAgentTraceContinuation(first, first, 'retry') })
      .toThrow('tool retry requires an explicit idempotency decision')
  })

  it('refuses a record whose turn or step id does not match its Session numbers', () => {
    const malformed = { ...modelAttempt('attempt-1'), turnId: agentTraceTurnId(SessionId('other'), 3) }
    expect(() => { assertAgentTraceContinuation(malformed, malformed, 'reconnect') })
      .toThrow('agent trace identity does not match its DSH turn and step')
  })

  it('derives unambiguous ids from session and one-based event numbers', () => {
    const left = agentTraceTurnId(SessionId('a,b'), 1)
    const right = agentTraceTurnId(SessionId('a'), 1)
    expect(left).not.toBe(right)
    expect(agentTraceStepId(left, 1)).not.toBe(agentTraceStepId(left, 2))
    expect(() => agentTraceTurnId(SessionId('session'), 0)).toThrow(RangeError)
    expect(() => agentTraceStepId(left, 1.5)).toThrow(RangeError)
  })
})
