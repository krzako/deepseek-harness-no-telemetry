/** Driver-neutral preparation and dispatch of one portable Session transfer. */

import type { AgentHandle, AgentSetup } from './index.ts'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock, LlmAuthenticationInfo } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  assessPortableImportV1,
  isPortableAgentContextV1,
  isPrivateDriverSnapshotV1,
  type AgentDriverStateV1,
  type PortableAgentContextV1,
  type PortableAgentContextStreamV1,
  type PortableImportAssessmentV1,
  type PortableImportCapabilitiesV1,
  type PrivateDriverSnapshotV1,
} from './portable-session.ts'

/** Fresh-session ancestry that the destination must persist with its driver state. */
export type AgentTransferLineageV1 = NonNullable<AgentDriverStateV1['lineage']>

/** The canonical context and optional same-driver checkpoint supplied by an exporter. */
export interface PortableAgentBundleV1 {
  readonly context: PortableAgentContextV1
  readonly privateSnapshot?: PrivateDriverSnapshotV1
}

/** Single-consumption context export with optional resident or streamed private state. */
export interface PortableAgentStreamBundleV1 {
  readonly context: PortableAgentContextStreamV1
  readonly privateSnapshot?: PrivateDriverSnapshotV1 | PortablePrivateSnapshotStreamV1
}

/** Source-validated canonical JSON context for one private checkpoint. */
export interface PortablePrivateSnapshotStreamV1 extends Omit<PrivateDriverSnapshotV1, 'context'> {
  /** Exact `JSON.stringify(context)` bytes; the source validates its driver schema before returning. */
  readonly contextJson: AsyncIterable<Uint8Array>
  readonly contextBytes: number
  readonly contextSha256: string
}

/** Detached archive facts and a caller-owned, verified content-addressed reader. */
export interface ArchivedAgentSource {
  readonly session: Session
  /** Read one declared archive artifact, verifying exact bytes before EOF.
   * @param sha256 - artifact digest, never a filesystem path.
   * @param bytes - exact byte count recorded by the source Session.
   * @returns artifact chunks; missing or changed bytes reject.
   */
  readArtifact(this: void, sha256: string, bytes: number): AsyncIterable<Uint8Array>
}

/** Source-driver port; the source id and context owner must agree. */
export interface AgentTransferSourcePort {
  readonly driverId: string
  /** Project an archive without reading live Session state or local artifacts.
   * @param input - detached Session and archive-only artifact reader.
   * @returns the same canonical bundle the source would export from these facts.
   */
  exportArchivedContext(input: ArchivedAgentSource): Promise<PortableAgentBundleV1>
  /** Export the complete canonical model-visible context at a completed turn boundary;
   * reject an active turn rather than transfer a partial one.
   * @param sessionId - source Session identity.
   * @returns canonical context and optional private checkpoint.
   */
  exportPortableContext(sessionId: SessionId): Promise<PortableAgentBundleV1>
  /** Optional single-use export for ZIP consumers. Acquire a stable completed-turn
   * snapshot before returning; the consumer reads the iterables after its durable
   * Session-log consistency check. Import preview continues to use the resident API.
   * @param sessionId - source Session identity.
   * @returns canonical context stream and optional private checkpoint.
   */
  exportPortableContextStream?(sessionId: SessionId): Promise<PortableAgentStreamBundleV1>
}

/** Target-driver port; implementations consume only the shared DSH format. */
export interface AgentTransferTargetPort<Result> {
  readonly driverId: string
  /** Declare accepted context, private checkpoint and model capabilities before import.
   * @returns destination capabilities for compatibility assessment.
   */
  importCapabilities(): PortableImportCapabilitiesV1 | Promise<PortableImportCapabilitiesV1>
  /** Read local authentication facts without returning secrets or calling a model.
   * @param model - an available destination route selected for import.
   * @returns credential presence or an explicit unverified/provider-managed status.
   */
  describeAuthentication(model: AgentDriverStateV1['model']): Promise<LlmAuthenticationInfo>
  /** Prepare state for a new destination Session from the canonical context and lineage,
   * without replacing the source driver's live Session or replaying historical effects.
   * @param input - validated context, optional compatible private checkpoint and fresh Session id.
   * @returns destination-specific preparation for later Session creation.
   */
  importPortableContext(input: {
    readonly context: PortableAgentContextV1
    readonly privateSnapshot?: PrivateDriverSnapshotV1
    readonly targetSessionId: SessionId
    /** Archive-validated references keyed by portableAttachmentKey, available in the destination store. */
    readonly attachments?: ReadonlyMap<string, Extract<ContentBlock, { type: 'image' | 'file' }>>
    /** Frozen route selected for the destination, validated again at commit. */
    readonly targetModel: AgentDriverStateV1['model']
    /** Persist on the new Session; never overwrite the source Session's driver. */
    readonly lineage: AgentTransferLineageV1
  }): Promise<Result>
}

/** Creation-time destination scope for a reviewed import; workspace application is external. */
export interface ImportedAgentOptions {
  readonly cwd?: string
  readonly setup?: AgentSetup
  readonly signal?: AbortSignal
}

/** Publication capability required from every registered full-agent target. */
export interface AgentImportPublisher<Preparation> {
  /** Create a fresh Agent through the shared factory without replaying history.
   * @param preparation - reviewed preparation produced by this target port.
   * @param options - destination workspace, unpublished setup and cancellation.
   * @returns owned handle after the factory's publication commit.
   */
  createImportedAgent(preparation: Preparation, options?: ImportedAgentOptions): Promise<AgentHandle>
}

/** One driver's canonical source and complete target capabilities. */
export interface AgentTransferPorts<Result = unknown> {
  readonly source: AgentTransferSourcePort
  readonly target: AgentTransferTargetPort<Result> & AgentImportPublisher<Result>
}

/** Reviewed transfer ready for a single destination-driver invocation. */
export interface PreparedAgentTransfer<Result> {
  readonly assessment: PortableImportAssessmentV1
  readonly sourceSessionId: SessionId
  readonly targetSessionId: SessionId
  /** Destination route captured at preview; source model remains in context provenance. */
  readonly targetModel: AgentDriverStateV1['model']
  /** Stable ancestry and transfer identity for the destination's new Session. */
  readonly lineage: AgentTransferLineageV1
  /** Refuse errors and unacknowledged warnings; never invoke the target twice.
   * @param acknowledgeWarnings - explicit acceptance of every reported warning.
   * @returns one memoized destination preparation.
   */
  commit(acknowledgeWarnings: boolean): Promise<Result>
}

/**
 * Export, validate and assess a portable transfer without touching the destination.
 * @param source - port of the driver owning the source Session.
 * @param target - port of the explicitly chosen destination driver.
 * @param sourceSessionId - source Session identity.
 * @param targetSessionId - fresh destination identity, never a resume target.
 * @param targetModel - selected destination model, checked against the target catalog.
 * @param attachments - references keyed by portableAttachmentKey, already available to the destination.
 * @returns assessment and one-shot commit that invokes only the target port.
 */
export async function prepareAgentTransfer<Result>(
  source: AgentTransferSourcePort,
  target: AgentTransferTargetPort<Result>,
  sourceSessionId: SessionId,
  targetSessionId: SessionId,
  targetModel: AgentDriverStateV1['model'],
  attachments: ReadonlyMap<string, Extract<ContentBlock, { type: 'image' | 'file' }>> = new Map(),
): Promise<PreparedAgentTransfer<Result>> {
  if (sourceSessionId === targetSessionId) throw new Error('portable import requires a new Session id')
  const selectedModel = Object.freeze({ ...targetModel })
  const selectedAttachments = new Map([...attachments].map(([id, block]) => [id, structuredClone(block)] as const))
  const bundle = structuredClone(await source.exportPortableContext(sourceSessionId))
  if (!isPortableAgentContextV1(bundle.context)) throw new TypeError('source driver exported invalid portable context')
  if (bundle.context.source.sessionId !== sourceSessionId || bundle.context.source.driver.id !== source.driverId) {
    throw new Error('source driver and exported Session identity do not match')
  }
  if (bundle.privateSnapshot !== undefined && (!isPrivateDriverSnapshotV1(bundle.privateSnapshot)
    || bundle.privateSnapshot.driverId !== source.driverId)) {
    throw new TypeError('source driver exported invalid private checkpoint')
  }
  const capabilities = await target.importCapabilities()
  if (capabilities.driverId !== target.driverId) throw new Error('destination driver and import capabilities do not match')
  const assessed = assessPortableImportV1(bundle.context, capabilities, selectedModel, bundle.privateSnapshot)
  const assessment: PortableImportAssessmentV1 = Object.freeze({
    ...assessed,
    issues: Object.freeze(assessed.issues.map(issue => Object.freeze({ ...issue }))),
  })
  const lineage: AgentTransferLineageV1 = Object.freeze({
    sourceSessionId,
    sourceDriverId: source.driverId,
    importId: randomUUID(),
  })
  let committed: Promise<Result> | undefined
  return {
    assessment,
    sourceSessionId,
    targetSessionId,
    targetModel: selectedModel,
    lineage,
    commit(acknowledgeWarnings) {
      if (assessment.issues.some(issue => issue.severity === 'error')) {
        throw new Error('portable import has blocking compatibility errors')
      }
      if (!acknowledgeWarnings && assessment.issues.some(issue => issue.severity === 'warning')) {
        throw new Error('portable import warnings require acknowledgment')
      }
      committed ??= Promise.resolve().then(async () => {
        const current = await target.importCapabilities()
        if (current.driverId !== target.driverId
          || !current.availableModels.some(model => model.provider === selectedModel.provider && model.id === selectedModel.id)) {
          throw new Error('selected target model is unavailable at import commit')
        }
        return target.importPortableContext({
          context: bundle.context,
          ...assessment.fidelity === 'same-driver' && bundle.privateSnapshot !== undefined
            ? { privateSnapshot: bundle.privateSnapshot }
            : {},
          targetSessionId,
          ...selectedAttachments.size === 0 ? {} : { attachments: selectedAttachments },
          targetModel: selectedModel,
          lineage,
        })
      })
      return committed
    },
  }
}

/** Compare all archived context and private state with the source driver's projection.
 * This operation never invokes a target driver or publishes a Session.
 * @param source - registered source driver, independent of the destination agent.
 * @param input - detached archived Session and verified artifact reader.
 * @param expected - schema-validated bundle from the same archive.
 */
export async function verifyArchivedAgentContext(
  source: AgentTransferSourcePort,
  input: ArchivedAgentSource,
  expected: PortableAgentBundleV1,
): Promise<void> {
  if (source.driverId !== expected.context.source.driver.id || input.session.id !== expected.context.source.sessionId) {
    throw new Error('archive projection source identity does not match')
  }
  const events = input.session.snapshotEvents()
  const projected = await source.exportArchivedContext(input)
  if (input.session.snapshotEvents() !== events) throw new Error('archive projection modified its Session')
  if (!deepEqualJson(projected, expected)) throw new Error('archive context or private checkpoint differs from source projection')
}
