/** Host fold for the persistent DSH-to-Codex thread binding. */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { CodexThreadBinding, CodexThreadBindingProjection } from './types.ts'

const bindingSchema: ZodType<CodexThreadBinding> = zod.object({
  version: zod.literal(1),
  threadId: zod.string().min(1) as unknown as ZodType<CodexThreadBinding['threadId']>,
  runtimeVersion: zod.string().min(1),
  cwd: zod.string().min(1),
}).strict()

const stateSchema: ZodType<CodexThreadBindingProjection> = zod.object({
  binding: bindingSchema.nullable(),
  conflict: zod.string().min(1).nullable(),
}).strict()

/** Fold the first binding and retain a permanent diagnostic for any different rebinding. */
export const codexThreadBindingProjectionDefinition = {
  key: 'codexThreadBinding',
  stateVersion: 1,
  stateSchema,
  init: (): CodexThreadBindingProjection => ({ binding: null, conflict: null }),
  apply: (state, event) => {
    if (event.type !== 'codex/thread-bound') return state
    if (state.conflict !== null) return state
    if (state.binding === null) return { binding: event.data, conflict: null }
    if (state.binding.threadId === event.data.threadId
      && state.binding.runtimeVersion === event.data.runtimeVersion
      && state.binding.cwd === event.data.cwd) return state
    return {
      binding: state.binding,
      conflict: `session binds Codex threads "${state.binding.threadId}" and "${event.data.threadId}"`,
    }
  },
} satisfies ProjectionDefinition<'codexThreadBinding', CodexThreadBindingProjection>
