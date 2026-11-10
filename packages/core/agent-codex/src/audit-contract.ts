/** Versioned Codex facts admitted to the durable DSH Session audit stream. */

import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'

const identity = z.string().min(1).max(256)
const payload = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inline'), value: z.custom<JsonValue>(isJsonValue) }),
  z.strictObject({
    kind: z.literal('artifact'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(256),
  }),
])
const artifact = payload.options[1]
const base = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  eventId: identity,
  time: z.number().int().nonnegative(),
  threadId: identity,
  turn: z.number().int().nonnegative(),
  codexTurnId: identity.optional(),
})
const model = base.extend({
  attemptId: identity,
  purpose: z.enum(['inference', 'compaction']),
})
const tool = base.extend({ codexCallId: identity })
const compaction = base.extend({ compactionId: identity })

/** One payload is inline JSON or a session-owned, SHA-256-verified artifact. */
export type CodexAuditPayloadV1 = z.infer<typeof payload>
/** Opaque artifact identity; no host path or public URL is accepted in an event. */
export type CodexAuditArtifactV1 = z.infer<typeof artifact>

/** Every event is replayed in sequence for one Codex thread; eventId is its retry key. */
export const CodexAuditEventV1Schema = z.discriminatedUnion('kind', [
  model.extend({ kind: z.literal('model/request'), stage: z.enum(['model-visible', 'upstream']),
    apiFormat: z.enum(['responses', 'chat-completions']), request: payload }),
  model.extend({ kind: z.literal('model/stream'), stage: z.enum(['codex', 'upstream']),
    index: z.number().int().nonnegative(), chunk: payload }),
  model.extend({ kind: z.literal('model/result'), stage: z.enum(['codex', 'upstream']),
    result: payload }),
  model.extend({ kind: z.literal('model/failure'), stage: z.enum(['codex', 'upstream']),
    code: identity.optional(), message: z.string().min(1), details: payload.optional() }),
  tool.extend({ kind: z.literal('tool/request'), name: identity, arguments: payload }),
  tool.extend({ kind: z.literal('tool/approval'), decision: z.enum(['approved', 'denied', 'cancelled', 'not-required']),
    request: payload.optional(), response: payload.optional() }),
  tool.extend({ kind: z.literal('tool/result'), outcome: z.enum(['success', 'error', 'cancelled', 'unknown']),
    result: payload }),
  compaction.extend({ kind: z.literal('compaction/request'), reason: z.string().min(1),
    inputHistory: payload, prompt: payload }),
  compaction.extend({ kind: z.literal('compaction/result'), result: payload }),
  compaction.extend({ kind: z.literal('compaction/pending'), effectiveHistory: payload,
    priorRolloutSha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
  compaction.extend({ kind: z.literal('compaction/installed'), effectiveHistory: payload }),
  compaction.extend({ kind: z.literal('compaction/aborted'), effectiveHistory: payload,
    reason: z.string().min(1) }),
  compaction.extend({ kind: z.literal('compaction/failure'), message: z.string().min(1),
    details: payload.optional() }),
  base.extend({ kind: z.literal('context/config'), config: payload }),
  base.extend({ kind: z.literal('checkpoint'), checkpointId: identity,
    snapshot: artifact, effectiveHistorySha256: z.string().regex(/^[0-9a-f]{64}$/) }),
])

/** Versioned Codex audit fact validated before durable DSH append. */
export type CodexAuditEventV1 = z.infer<typeof CodexAuditEventV1Schema>

/** Reject malformed or future-version facts before append, ACK, or import.
 * @param value - untrusted audit event payload.
 * @returns a validated V1 fact.
 */
export function parseCodexAuditEventV1(value: unknown): CodexAuditEventV1 {
  return CodexAuditEventV1Schema.parse(value)
}
