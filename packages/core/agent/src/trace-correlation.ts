/** Versioned identities shared by model and tool audit records of one Agent step. */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Serialized correlation format for Agent audit records. */
export const AGENT_TRACE_CORRELATION_VERSION = 1 as const

/** DSH-owned turn identity; distinct from a driver's own turn identifier. */
export type AgentTraceTurnId = Branded<'AgentTraceTurnId'>

/** DSH-owned step identity, stable across model retries. */
export type AgentTraceStepId = Branded<'AgentTraceStepId'>

/** Driver-owned thread identity, absent for drivers without a thread. */
export type AgentDriverThreadId = Branded<'AgentDriverThreadId'>

/** Driver-owned turn identity, distinct from the DSH turn. */
export type AgentDriverTurnId = Branded<'AgentDriverTurnId'>

/**
 * Construct a driver-owned thread identity without changing its serialized value.
 * @param id - non-empty thread id reported by the driver.
 * @returns the branded id.
 * @throws when the id is empty.
 */
export function agentDriverThreadId(id: string): AgentDriverThreadId {
  if (id.length === 0) throw new TypeError('agent driver thread id must be non-empty')
  return brandString<AgentDriverThreadId>(id)
}

/**
 * Construct a driver-owned turn identity without changing its serialized value.
 * @param id - non-empty turn id reported by the driver.
 * @returns the branded id.
 * @throws when the id is empty.
 */
export function agentDriverTurnId(id: string): AgentDriverTurnId {
  if (id.length === 0) throw new TypeError('agent driver turn id must be non-empty')
  return brandString<AgentDriverTurnId>(id)
}

/**
 * Derive one stable turn id from the DSH Session and its one-based turn number.
 * @param sessionId - durable Session identity.
 * @param turn - one-based turn number in that Session.
 * @returns an opaque id unchanged by retry or reconnect.
 * @throws when turn is not a positive safe integer.
 */
export function agentTraceTurnId(sessionId: SessionId, turn: number): AgentTraceTurnId {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new RangeError('agent turn must be a positive safe integer')
  return brandString<AgentTraceTurnId>(JSON.stringify([sessionId, turn]))
}

/**
 * Derive one stable step id from the DSH turn and its one-based step number.
 * @param turnId - DSH turn identity.
 * @param step - one-based step number within that turn.
 * @returns an opaque id shared by every attempt of that step.
 * @throws when step is not a positive safe integer.
 */
export function agentTraceStepId(turnId: AgentTraceTurnId, step: number): AgentTraceStepId {
  if (!Number.isSafeInteger(step) || step < 1) throw new RangeError('agent step must be a positive safe integer')
  return brandString<AgentTraceStepId>(JSON.stringify([turnId, step]))
}

/** The common identity of all operations in one DSH Agent step. */
export interface AgentTraceScopeV1 {
  readonly version: typeof AGENT_TRACE_CORRELATION_VERSION
  readonly sessionId: SessionId
  /** Agent driver key, independent of model/provider selection. */
  readonly driverId: string
  /** Optional driver-owned thread id; never replaces sessionId. */
  readonly threadId?: AgentDriverThreadId
  /** Optional driver-owned turn id; never replaces the DSH turnId. */
  readonly driverTurnId?: AgentDriverTurnId
  /** One-based DSH turn number recorded by the Session. */
  readonly turn: number
  /** One-based DSH step number within the turn. */
  readonly step: number
  readonly turnId: AgentTraceTurnId
  readonly stepId: AgentTraceStepId
}

/** One physical provider attempt or one model-issued tool call. */
export type AgentTraceCorrelationV1 = AgentTraceScopeV1 & (
  | { readonly kind: 'model-attempt'; readonly modelAttemptId: LlmAttemptId; readonly toolCallId?: never }
  | { readonly kind: 'tool-call'; readonly toolCallId: ToolCallId; readonly modelAttemptId?: never }
)

/**
 * Refuse a retry/reconnect that changes the parent step or reuses the wrong operation id.
 * A retry is a new physical model request with a new attempt id; reconnecting to
 * the same request or tool call preserves its id. Tool retries require separate
 * idempotency policy and cannot be declared through this operation.
 * @param previous - operation identity already accepted by the audit.
 * @param next - identity proposed for the continuation.
 * @param continuation - retry of a model request or reconnect to the same operation.
 * @throws when the identities do not represent the specified continuation.
 */
export function assertAgentTraceContinuation(
  previous: AgentTraceCorrelationV1,
  next: AgentTraceCorrelationV1,
  continuation: 'retry' | 'reconnect',
): void {
  if (previous.sessionId !== next.sessionId
    || previous.driverId !== next.driverId
    || previous.threadId !== next.threadId
    || previous.driverTurnId !== next.driverTurnId
    || previous.turn !== next.turn
    || previous.step !== next.step
    || previous.turnId !== next.turnId
    || previous.stepId !== next.stepId
    || previous.kind !== next.kind) {
    throw new Error('agent trace continuation changed its step identity')
  }
  if (previous.turnId !== agentTraceTurnId(previous.sessionId, previous.turn)
    || previous.stepId !== agentTraceStepId(previous.turnId, previous.step)) {
    throw new Error('agent trace identity does not match its DSH turn and step')
  }
  if (previous.kind === 'tool-call' && next.kind === 'tool-call') {
    if (continuation === 'retry') throw new Error('tool retry requires an explicit idempotency decision')
    if (previous.toolCallId !== next.toolCallId) throw new Error('tool reconnect changed its call id')
    return
  }
  if (previous.kind === 'model-attempt' && next.kind === 'model-attempt') {
    if (continuation === 'retry' && previous.modelAttemptId === next.modelAttemptId) {
      throw new Error('model retry reused its attempt id')
    }
    if (continuation === 'reconnect' && previous.modelAttemptId !== next.modelAttemptId) {
      throw new Error('model reconnect changed its attempt id')
    }
  }
}
