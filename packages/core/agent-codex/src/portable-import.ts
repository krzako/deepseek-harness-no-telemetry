/** Publish one reviewed Codex import through the shared Agent factory. */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, ImportedAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CodexAgent } from './agent.ts'
import { isCodexContextSnapshotV2 } from './context-snapshot.ts'
import type { CodexImportPreparation } from './portable-target.ts'

/** Creation-time workspace, scoped composition, and cancellation. */
export type CodexImportedAgentOptions = ImportedAgentOptions

/** Create an unpublished DSH Session and a fresh Codex thread from a reviewed V2 checkpoint.
 * The shared factory publishes only after the thread starts. Historical model
 * and tool actions are data in the checkpoint and are never replayed.
 * @param ctx - owner context with registered Agent factory and Codex driver.
 * @param preparation - committed target-port result.
 * @param options - destination workspace, optional setup and cancellation.
 * @returns the published Agent handle.
 */
export function createCodexImportedAgent(
  ctx: Context,
  preparation: CodexImportPreparation,
  options: CodexImportedAgentOptions = {},
): Promise<AgentHandle> {
  const snapshot = preparation.privateSnapshot
  if (preparation.context.source.driver.id !== 'codex'
    || preparation.lineage.sourceDriverId !== 'codex'
    || preparation.lineage.sourceSessionId !== preparation.context.source.sessionId
    || snapshot?.driverId !== 'codex' || snapshot.schemaVersion !== 2
    || !isCodexContextSnapshotV2(snapshot.context)) {
    throw new Error('Codex same-driver import requires a compatible private V2 checkpoint')
  }
  const checkpoint = snapshot.context
  return ctx.agents.create({
    sessionId: preparation.targetSessionId,
    route: { kind: 'import', driverId: 'codex' },
    meta: {
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      importLineage: {
        sourceSessionId: SessionId(preparation.lineage.sourceSessionId),
        sourceDriverId: preparation.lineage.sourceDriverId,
        importId: preparation.lineage.importId,
      },
    },
    agentOptions: { provider: preparation.targetModel.provider, model: preparation.targetModel.id },
    setup: async (agentCtx) => {
      if (!(agentCtx.agent instanceof CodexAgent)) throw new Error('Codex import selected a non-Codex driver')
      agentCtx.agent.installImportCheckpoint(checkpoint)
      return options.setup?.(agentCtx)
    },
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
}
