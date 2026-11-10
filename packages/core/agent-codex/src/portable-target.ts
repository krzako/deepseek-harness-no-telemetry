/** Prepare a canonical DSH context for a future Codex thread import. */

import { isPortableAgentContextV1, isPrivateDriverSnapshotV1,
  type AgentDriverStateV1, type AgentTransferLineageV1, type AgentTransferTargetPort,
  type PortableAgentContextV1, type PrivateDriverSnapshotV1 } from '@deepseek-ai/dsh-agent'
import type { LlmAuthenticationInfo } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { isCodexContextSnapshotV2 } from './context-snapshot.ts'

/** Unpublished state for the later fresh-Session and fork-thread transaction. */
export interface CodexImportPreparation {
  readonly context: PortableAgentContextV1
  readonly privateSnapshot?: PrivateDriverSnapshotV1
  readonly targetSessionId: SessionId
  readonly targetModel: AgentDriverStateV1['model']
  readonly lineage: AgentTransferLineageV1
}

/** Declare Codex import compatibility without creating a thread or replaying effects.
 * The fork-thread restoration operation is separate; this port only freezes
 * validated inputs for that later transaction.
 * @param models - current configured Codex routes for preview and commit.
 * @param revision - fork revision whose private V2 checkpoint can be restored.
 * @param authentication - current local auth inspector; absent inspectors report unverified.
 * @returns target port yielding unpublished preparation.
 */
export function codexTransferTarget(
  models: () => readonly AgentDriverStateV1['model'][] | Promise<readonly AgentDriverStateV1['model'][]>,
  revision: () => string,
  authentication: (model: AgentDriverStateV1['model']) => Promise<LlmAuthenticationInfo> = () => Promise.resolve({ status: 'unverified' }),
): AgentTransferTargetPort<CodexImportPreparation> {
  const capabilities = async () => {
    const currentRevision = revision()
    if (currentRevision.length === 0) throw new Error('Codex import requires a known fork revision')
    return { driverId: 'codex', supportedContextVersions: [1], supportedPrivateSnapshotVersions: [2],
      supportedPrivateRevisions: [currentRevision], supportedOpaqueNamespaces: [],
      availableModels: await models() }
  }
  return {
    driverId: 'codex',
    describeAuthentication: authentication,
    importCapabilities: capabilities,
    async importPortableContext(input) {
      const current = await capabilities()
      if (!isPortableAgentContextV1(input.context)) throw new TypeError('Codex import requires canonical V1 context')
      if (input.targetSessionId === input.context.source.sessionId) {
        throw new Error('Codex import requires a new Session id')
      }
      if (input.lineage.sourceSessionId !== input.context.source.sessionId
        || input.lineage.sourceDriverId !== input.context.source.driver.id) {
        throw new Error('Codex import lineage does not match the source context')
      }
      if (!current.availableModels.some(model => model.provider === input.targetModel.provider
        && model.id === input.targetModel.id)) {
        throw new Error(`Codex import model ${input.targetModel.provider}/${input.targetModel.id} is unavailable`)
      }
      if (input.privateSnapshot !== undefined && (!isPrivateDriverSnapshotV1(input.privateSnapshot)
        || input.context.source.driver.id !== 'codex' || input.privateSnapshot.driverId !== 'codex'
        || input.privateSnapshot.schemaVersion !== 2
        || input.privateSnapshot.driverRevision !== current.supportedPrivateRevisions[0]
        || !isCodexContextSnapshotV2(input.privateSnapshot.context))) {
        throw new Error('Codex import private V2 checkpoint is incompatible')
      }
      return deepFreeze(structuredClone({ context: input.context,
        ...input.privateSnapshot === undefined ? {} : { privateSnapshot: input.privateSnapshot },
        targetSessionId: input.targetSessionId, targetModel: input.targetModel, lineage: input.lineage }))
    },
  }
}
