/** Standard-driver adapters for the shared portable transfer ports. */

import type { LlmAuthenticationInfo } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  PORTABLE_AGENT_VERSION,
  type AgentDriverStateV1,
  type PortableAgentContextV1,
} from './portable-session.ts'
import { projectStandardImport, type StandardImportProjection } from './standard-session-import.ts'
import { projectStandardSession, projectStandardSessionStream } from './standard-session-export.ts'
import type {
  AgentTransferLineageV1,
  AgentTransferSourcePort,
  AgentTransferTargetPort,
} from './session-transfer.ts'

/** Unpublished inputs retained by the later standard Session creation transaction. */
export interface StandardImportPreparation {
  readonly context: PortableAgentContextV1
  readonly projection: StandardImportProjection
  readonly targetSessionId: SessionId
  readonly targetModel: AgentDriverStateV1['model']
  readonly lineage: AgentTransferLineageV1
}

/**
 * Adapt a live or restored standard Session resolver to the shared source port.
 * The resolver must supply a complete durable Session for the requested id.
 * @param resolve - locate the source Session without changing its state.
 * @returns standard driver's portable source port.
 */
export function standardTransferSource(
  resolve: (sessionId: SessionId) => Session | undefined | Promise<Session | undefined>,
): AgentTransferSourcePort {
  const completed = async (sessionId: SessionId): Promise<Session> => {
    const session = await resolve(sessionId)
    if (session === undefined || session.id !== sessionId) {
      throw new Error(`standard Session ${sessionId} is unavailable`)
    }
    return session
  }
  return {
    driverId: 'standard',
    exportArchivedContext({ session }) {
      return Promise.resolve({ context: projectStandardSession(session) })
    },
    async exportPortableContext(sessionId) {
      return { context: projectStandardSession(await completed(sessionId)) }
    },
    async exportPortableContextStream(sessionId) {
      return { context: projectStandardSessionStream(await completed(sessionId)) }
    },
  }
}

/**
 * Adapt the standard driver's pure import projection to the shared target port.
 * The model catalog is read from the importing environment; resolved attachment
 * references arrive with each transfer rather than being retained by the port.
 * The returned preparation has no published Session or executed historical work.
 * @param models - current destination catalog, checked at preview and commit.
 * @param authentication - current local auth inspector; absent inspectors report unverified.
 * @returns standard driver's portable target port.
 */
export function standardTransferTarget(
  models: () => readonly AgentDriverStateV1['model'][] | Promise<readonly AgentDriverStateV1['model'][]>,
  authentication: (model: AgentDriverStateV1['model']) => Promise<LlmAuthenticationInfo> = () => Promise.resolve({ status: 'unverified' }),
): AgentTransferTargetPort<StandardImportPreparation> {
  return {
    driverId: 'standard',
    describeAuthentication: authentication,
    async importCapabilities() {
      return {
        driverId: 'standard',
        supportedContextVersions: [PORTABLE_AGENT_VERSION],
        supportedPrivateSnapshotVersions: [],
        supportedPrivateRevisions: [],
        supportedOpaqueNamespaces: [],
        availableModels: await models(),
      }
    },
    async importPortableContext(input) {
      if (!(await models()).some(model => model.provider === input.targetModel.provider && model.id === input.targetModel.id)) {
        throw new Error(`standard import model ${input.targetModel.provider}/${input.targetModel.id} is unavailable`)
      }
      if (input.targetSessionId === input.context.source.sessionId) {
        throw new Error('standard import requires a new Session id')
      }
      if (input.lineage.sourceSessionId !== input.context.source.sessionId
        || input.lineage.sourceDriverId !== input.context.source.driver.id) {
        throw new Error('standard import lineage does not match the source context')
      }
      if (input.privateSnapshot !== undefined) {
        throw new Error('standard driver does not accept a private checkpoint')
      }
      const projection = projectStandardImport(
        input.context, input.targetSessionId, input.targetModel, input.attachments ?? new Map(),
      )
      return deepFreeze(structuredClone({
        context: input.context,
        projection,
        targetSessionId: input.targetSessionId,
        targetModel: input.targetModel,
        lineage: input.lineage,
      }))
    },
  }
}
