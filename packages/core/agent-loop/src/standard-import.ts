/** Publish a prepared same-driver standard import as one new Agent Session. */

import type { Context } from '@deepseek-ai/cordis'
import { buildStandardImportSeed, type AgentHandle, type ImportedAgentOptions, type StandardImportPreparation } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Creation-time workspace, scope composition, and cancellation for an imported Session. */
export type StandardImportedAgentOptions = ImportedAgentOptions

/**
 * Create a new standard Agent from a reviewed standard-source preparation.
 * The factory persists the seed and lineage before publication. It does not
 * replay any historical model request or tool call. The source Session remains
 * untouched; archived attachment bytes must already be available to the scope.
 * @param ctx - owner context with the registered Agent factory.
 * @param preparation - committed result of the standard target port.
 * @param options - destination workspace, optional scope setup and cancellation.
 * @returns the new Agent handle after publication.
 */
export function createStandardImportedAgent(
  ctx: Context,
  preparation: StandardImportPreparation,
  options: StandardImportedAgentOptions = {},
): Promise<AgentHandle> {
  if (preparation.context.source.driver.id !== 'standard'
    || preparation.lineage.sourceDriverId !== 'standard'
    || preparation.lineage.sourceSessionId !== preparation.context.source.sessionId) {
    throw new Error('standard same-driver import requires matching standard source identity')
  }
  const seed = buildStandardImportSeed(preparation)
  if (seed.systemInstruction === undefined) {
    throw new Error('standard same-driver import has no representable system instruction')
  }
  return ctx.agents.create({
    sessionId: preparation.targetSessionId,
    route: { kind: 'import', driverId: 'standard' },
    seed: seed.events,
    meta: {
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      importLineage: {
        sourceSessionId: SessionId(preparation.lineage.sourceSessionId),
        sourceDriverId: preparation.lineage.sourceDriverId,
        importId: preparation.lineage.importId,
      },
    },
    agentOptions: { provider: preparation.targetModel.provider, model: preparation.targetModel.id },
    ...options.setup === undefined ? {} : { setup: options.setup },
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
}
