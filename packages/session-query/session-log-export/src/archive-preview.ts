/** Read-only archive validation and destination context compatibility assessment. */

import { assessPortableImportV1, type AgentDriverStateV1, type AgentTransferSourcePort,
  type AgentTransferTargetPort, type PortableImportAssessmentV1 } from '@deepseek-ai/dsh-agent'
import type { SessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { readDshSessionArchiveBundle, type DshArchiveBundlePreview } from './archive-bundle.ts'
import { verifyDshSessionArchiveProjection } from './archive-projection.ts'
import { validateDshSessionZip, type DshZipValidationPolicy } from './zip-validation.ts'
import { previewDshWorkspaceImport, type DshWorkspaceImportPreview } from './workspace-preview.ts'
import type { DshSessionArchiveManifestV1 } from './manifest.ts'
import { compareDshWorkspaceSnapshot, type DshWorkspaceEntryComparison } from './workspace-conflicts.ts'

/** Validated archive and context compatibility; workspace and remote credential validity require separate checks. */
export interface DshArchiveCompatibilityPreview extends DshArchiveBundlePreview {
  readonly manifest: DshSessionArchiveManifestV1
  readonly targetModel: AgentDriverStateV1['model']
  readonly workspace: DshWorkspaceImportPreview
  readonly workspaceEntries: readonly DshWorkspaceEntryComparison[] | null
  readonly targetDriverId: string
  readonly authentication: Awaited<ReturnType<AgentTransferTargetPort<unknown>['describeAuthentication']>>
  readonly assessment: PortableImportAssessmentV1
}

/** Validate a private archive before consulting destination capabilities.
 * Unsupported context/model choices return assessment issues; corrupt archives,
 * source projection mismatches and cancellation reject. This does not prepare
 * an import, publish a Session or verify remote credential validity and workspace readiness.
 * The caller owns stable private staging and its deletion on every outcome.
 * @param path - completed private staging ZIP.
 * @param catalog - installed Session format validation and migration catalog.
 * @param source - source port, or resolver called with the fully validated source driver identity.
 * @param target - destination capabilities, without invoking its import operation.
 * @param targetModel - explicit destination route, captured before asynchronous reads.
 * @param policy - optional resource limits for every ZIP scan.
 * @param signal - cancellation of reads and result publication.
 * @param targetWorkspacePath - authorized absolute destination, or no workspace selected.
 * @returns validated source data and the destination's context compatibility report.
 */
export async function previewDshSessionArchive(
  path: string,
  catalog: SessionFormatCatalog,
  source: AgentTransferSourcePort | ((driverId: string) => AgentTransferSourcePort),
  target: AgentTransferTargetPort<unknown>,
  targetModel: AgentDriverStateV1['model'],
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
  targetWorkspacePath: string | null = null,
): Promise<DshArchiveCompatibilityPreview> {
  const selectedModel = { ...targetModel }
  const manifest = await validateDshSessionZip(path, policy, signal)
  const preview = await readDshSessionArchiveBundle(path, manifest, catalog, policy, signal)
  const sourcePort = typeof source === 'function' ? source(preview.bundle.context.source.driver.id) : source
  await verifyDshSessionArchiveProjection(path, manifest, preview, sourcePort, policy, signal)
  signal?.throwIfAborted()
  const capabilities = await target.importCapabilities()
  signal?.throwIfAborted()
  if (capabilities.driverId !== target.driverId) {
    throw new Error('session import: destination driver and import capabilities do not match')
  }
  const assessment = assessPortableImportV1(preview.bundle.context, capabilities, selectedModel, preview.bundle.privateSnapshot)
  const authentication: DshArchiveCompatibilityPreview['authentication'] = assessment.issues.some(issue => issue.code === 'model-unavailable')
    ? { status: 'unverified' }
    : await target.describeAuthentication(selectedModel)
  signal?.throwIfAborted()
  const workspace = await previewDshWorkspaceImport(manifest.workspace, targetWorkspacePath, signal)
  const workspaceEntries = await compareDshWorkspaceSnapshot(manifest, workspace.targetExists ? workspace.targetPath : null, signal)
  return { ...preview, manifest, workspace, workspaceEntries, authentication,
    targetModel: selectedModel, targetDriverId: target.driverId, assessment }
}
