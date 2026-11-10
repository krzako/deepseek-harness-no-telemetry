/** Canonical DSH context plus the validated Codex-owned checkpoint. */

import { isAgentDriverStateV1, isPortableAgentContextV1,
  type AgentDriverStateV1, type PortableAgentContextV1 } from '@deepseek-ai/dsh-agent'
import type { PortableAgentBundleV1 } from '@deepseek-ai/dsh-agent'
import { codexPrivateSnapshot, isCodexContextSnapshotV2 } from './context-snapshot.ts'
import type { CodexPortableCompactionAudit } from './portable-compaction.ts'
import { projectCodexCompactionAncestry } from './portable-compaction.ts'
import { projectCodexEffectiveHistory, projectCodexHistoricalItems } from './portable-item.ts'

/**
 * Assemble a complete portable context from verified Codex projections.
 * The caller must obtain the checkpoint, driver state, tool outcomes, and
 * resolved audit groups from the same completed Session read barrier.
 * @param source - persisted driver selection and model route for this Session.
 * @param checkpoint - V2 checkpoint whose active history is the next prompt's base.
 * @param audits - installed compaction groups resolved from the durable audit.
 * @param outcomes - committed DSH tool outcomes by Codex call ID.
 * @returns one canonical bundle with the driver-private checkpoint intact.
 */
export function projectCodexPortableBundle(
  source: AgentDriverStateV1,
  checkpoint: unknown,
  audits: readonly CodexPortableCompactionAudit[],
  outcomes: ReadonlyMap<string, 'success' | 'error'>,
): PortableAgentBundleV1 {
  if (!isAgentDriverStateV1(source) || source.driver.id !== 'codex') {
    throw new TypeError('Codex portable source has invalid driver state')
  }
  if (!isCodexContextSnapshotV2(checkpoint)) throw new TypeError('Codex portable source requires a valid V2 checkpoint')
  const active = projectCodexEffectiveHistory(checkpoint, outcomes)
  const historical = projectCodexHistoricalItems(checkpoint, outcomes)
  const ancestry = projectCodexCompactionAncestry(audits, historical,
    active.length + historical.items.length, outcomes)
  const context: PortableAgentContextV1 = {
    version: 1,
    source,
    items: [...active, ...historical.items, ...ancestry.items],
    effectiveItemIds: active.map(item => item.id),
    compactions: ancestry.compactions,
  }
  if (!isPortableAgentContextV1(context)) throw new Error('Codex portable context has invalid item references')
  return { context, privateSnapshot: codexPrivateSnapshot(checkpoint) }
}
