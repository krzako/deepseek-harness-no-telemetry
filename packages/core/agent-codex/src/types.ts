/**
 * Durable Codex app-server identities and diagnostic events. These events
 * project Codex activity for DSH clients; Codex retains the model history.
 *
 * @module @deepseek-ai/dsh-agent-codex/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CodexAuditEventV1 } from './audit-contract.ts'

/** App-server thread identity persisted beside its owning DSH session. */
export type CodexThreadId = Branded<'CodexThreadId'>

/** App-server turn identity persisted with the corresponding DSH turn. */
export type CodexTurnId = Branded<'CodexTurnId'>

/** Current durable DSH-to-Codex thread binding. */
export interface CodexThreadBinding {
  /** Payload version for future adjacent readers. */
  readonly version: 1
  /** Persistent app-server thread resumed for every later DSH turn. */
  readonly threadId: CodexThreadId
  /** Exact packaged Codex runtime version that created the thread. */
  readonly runtimeVersion: string
  /** Absolute workspace path supplied when the thread was created. */
  readonly cwd: string
}

/** Host-only fold result used to resume one Codex-backed DSH session. */
export interface CodexThreadBindingProjection {
  /** The sole binding, or null before a Codex thread is committed. */
  readonly binding: CodexThreadBinding | null
  /** Conflicting binding diagnostic; a provider must refuse resume when set. */
  readonly conflict: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Durable Codex thread identity and any conflicting rebinding. */
    codexThreadBinding: CodexThreadBindingProjection
  }
  interface SessionProjectionMap {
    /** Whether this session owns a durable Codex thread. */
    codexThreadBinding: boolean
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable session ownership receipt for one byte-exact Codex audit artifact. */
    'codex/artifact-v1': {
      readonly version: 1
      readonly threadId: string
      readonly sha256: string
      readonly bytes: number
      readonly mediaType: string
      readonly name: string
    }
    /** Versioned Codex fact stream; the app-server channel supplies sequence and retry identity. */
    'codex/audit-v1': CodexAuditEventV1
    /** Exact deterministic tool catalog supplied to Codex before this turn starts. */
    'codex/tool-catalog': {
      readonly version: 1
      readonly turn: number
      readonly hash: string
      readonly tools: JsonValue
    }
    /** Correlates one validated native call with a stable DSH tool-call identity. */
    'codex/tool-call-bound': {
      readonly version: 1
      readonly turn: number
      readonly codexTurnId: CodexTurnId
      readonly codexCallId: string
      readonly dshCallId: string
      readonly catalogHash: string
      readonly name: string
      readonly arguments: JsonValue
    }
    /** Commits the one persistent Codex thread owned by this DSH session. */
    'codex/thread-bound': CodexThreadBinding
    /** Associates one DSH turn with the app-server turn that executes it. */
    'codex/turn-bound': {
      readonly version: 1
      readonly turn: number
      readonly codexTurnId: CodexTurnId
    }
    /** Full Codex/model transport facts, flushed before dispatch or downstream delivery. */
    'codex/model-audit': {
      readonly version: 1
      readonly turn: number
      readonly attemptId: string
      readonly purpose: 'inference' | 'compaction'
      readonly phase: 'original-request' | 'upstream-request' | 'upstream-response' | 'upstream-chunk' | 'upstream-end' | 'result' | 'failure'
      readonly payload: JsonValue
    }
    /** Records the initial structured snapshot of one native Codex item. */
    'codex/item/started': {
      readonly version: 1
      readonly turn: number
      readonly codexTurnId: CodexTurnId
      readonly itemId: string
      readonly itemType: string
      readonly item: JsonValue
    }
    /** Records a later complete snapshot of an in-progress native Codex item. */
    'codex/item/updated': {
      readonly version: 1
      readonly turn: number
      readonly codexTurnId: CodexTurnId
      readonly itemId: string
      readonly itemType: string
      readonly item: JsonValue
    }
    /** Records the terminal structured snapshot of one native Codex item. */
    'codex/item/completed': {
      readonly version: 1
      readonly turn: number
      readonly codexTurnId: CodexTurnId
      readonly itemId: string
      readonly itemType: string
      readonly item: JsonValue
    }
    /** Records provider token accounting without making it model history. */
    'codex/usage': {
      readonly version: 1
      readonly turn: number
      readonly inputTokens: number
      readonly cachedInputTokens: number
      readonly cacheWriteInputTokens: number
      readonly outputTokens: number
      readonly reasoningOutputTokens: number
    }
    /** Records a safe app-server failure summary for replay and diagnostics. */
    'codex/error': {
      readonly version: 1
      readonly turn: number
      readonly stage: 'thread' | 'turn-start' | 'turn' | 'interaction' | 'transport'
      readonly message: string
      readonly code?: string
    }
  }
}
