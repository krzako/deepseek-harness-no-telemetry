/** Reviewed archive import through the registered driver publication port. */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { prepareAgentTransfer, type AgentHandle, type AgentTransferPorts, type AgentTransferSourcePort,
  type ImportedAgentOptions, type AgentDriverStateV1 } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import { previewDshSessionArchive, type DshArchiveCompatibilityPreview } from './archive-preview.ts'
import { resolveDshArchiveAttachments } from './archive-attachments.ts'
import { restoreDshArchiveAttachments } from './restore-attachments.ts'
import { previewDshWorkspaceImport, type DshWorkspaceImportChoice } from './workspace-preview.ts'
import { DshArchiveStagingCleanupError, withDshWorkspaceSnapshot, type DshZipValidationPolicy } from './zip-validation.ts'
import { withDshNewWorkspace } from './new-workspace.ts'
import { createDshWorkspaceImportJournal } from './workspace-recovery.ts'
import { fingerprintDshWorkspace } from './workspace-fingerprint.ts'
import { createDshWorkspaceBackup } from './workspace-backup.ts'
import { captureDshWorkspaceExport } from './workspace-export.ts'
import { withDshWorkspaceReplacement } from './workspace-replacement.ts'

/** Caller-owned private archive and authorized destination; no HTTP authorization is implied. */
export interface DshArchiveImportOptions<Preparation> {
  readonly path: string
  readonly stagingParent: string
  readonly catalog: SessionFormatCatalog
  readonly source: AgentTransferSourcePort | ((driverId: string) => AgentTransferSourcePort)
  readonly target: AgentTransferPorts<Preparation>['target']
  readonly targetModel: AgentDriverStateV1['model']
  readonly store: Pick<AttachmentStore, 'restoreImage' | 'saveFileStream'>
  readonly workspace: { readonly action: DshWorkspaceImportChoice['action']; readonly path: string }
  readonly policy?: DshZipValidationPolicy
  readonly signal?: AbortSignal
  readonly setup?: ImportedAgentOptions['setup']
}

/** Successful publication; the caller owns the handle even when staging cleanup failed. */
export interface DshArchiveImportResult {
  readonly handle: AgentHandle
  /** Retained content backup and original tree for whole-workspace replacement, otherwise null. */
  readonly workspaceBackup: string | null
  /** Null means cleanup completed. A failure retains its path and cause for authorized inspection. */
  readonly stagingCleanup: { readonly path: string; readonly cause: unknown } | null
}

/** Detached review plus one publication attempt; a rejected attempt requires a fresh review. */
export interface PreparedDshArchiveImport {
  readonly preview: DshArchiveCompatibilityPreview
  readonly targetSessionId: SessionId
  /** True requires separate confirmation to replace the entire existing tree, including extra files. */
  readonly replacesExistingWorkspace: boolean
  /** Accept the displayed context and workspace warnings and publish once.
   * Missing acknowledgment does not consume the attempt. Concurrent accepted calls
   * share the same result; handle disposal belongs to the caller. A staging cleanup
   * failure after publication is returned separately and never rolls back the Session.
   * @param acknowledgeWarnings - explicit acceptance of all preview warnings.
   * @param confirmWorkspaceReplacement - separate acceptance of entire-tree replacement with a retained backup.
   * @returns the published handle, retained backup location and independent staging cleanup outcome.
   */
  commit(acknowledgeWarnings: boolean, confirmWorkspaceReplacement?: boolean): Promise<DshArchiveImportResult>
}

/** Validate and review an archive for a fresh Session with an explicit workspace choice.
 * Supports keeping existing files, creating a workspace, or separately confirmed
 * whole-tree replacement with a retained backup. Context-only import rejects before
 * writes. Commit revalidates the archive, restores attachments,
 * rechecks workspace observations and destination capabilities, then invokes the
 * driver's transactional publisher. Durable shared attachments survive failures;
 * the publisher owns Session rollback. The caller keeps the ZIP private and stable
 * through settlement and removes it afterwards. This does not reserve the workspace
 * against external writes, verify remote credentials or replay historical effects.
 * @param options - private staging, registered ports, explicit route and workspace.
 * @returns isolated preview and a single-attempt import operation.
 */
export async function prepareDshSessionArchiveImport<Preparation>(
  options: DshArchiveImportOptions<Preparation>,
): Promise<PreparedDshArchiveImport> {
  const { path, stagingParent, catalog, source, target, store, signal, setup } = options
  const workspace = { ...options.workspace }
  const policy = { ...options.policy }
  const model = { ...options.targetModel }
  if (workspace.action === 'context-only') throw new Error('session import: workspace action is not implemented')
  const preview = await previewDshSessionArchive(path, catalog, source, target, model, policy, signal, workspace.path)
  if (workspace.action === 'keep-workspace' && (!preview.workspace.targetExists || preview.workspace.targetPath === null)) {
    throw new Error('session import: keeping workspace requires an existing directory')
  }
  if (workspace.action === 'apply-snapshot' && preview.manifest.workspace.snapshot === null) {
    throw new Error('session import: applying a snapshot requires an archived snapshot')
  }
  const cwd = preview.workspace.targetPath
  if (cwd === null) throw new Error('session import: workspace destination is required')
  const identity = preview.workspace.targetExists ? await stat(cwd, { bigint: true }) : null
  const replacementReview = workspace.action === 'apply-snapshot' && preview.workspace.targetExists
    ? await captureDshWorkspaceExport(cwd, signal) : undefined
  const attachments = resolveDshArchiveAttachments(preview, preview.manifest)
  const targetSessionId = SessionId(randomUUID())
  const archiveSource: AgentTransferSourcePort = {
    driverId: preview.bundle.context.source.driver.id,
    exportArchivedContext: () => Promise.resolve(preview.bundle),
    exportPortableContext: () => Promise.resolve(preview.bundle),
  }
  const transfer = await prepareAgentTransfer(archiveSource, target, SessionId(preview.bundle.context.source.sessionId),
    targetSessionId, model, attachments)
  if (!isDeepStrictEqual(transfer.assessment, preview.assessment)) {
    throw new Error('session import: destination capabilities changed during review')
  }
  signal?.throwIfAborted()
  let committed: Promise<DshArchiveImportResult> | undefined
  return {
    preview: structuredClone(preview), targetSessionId, replacesExistingWorkspace: replacementReview !== undefined,
    commit(acknowledgeWarnings, confirmWorkspaceReplacement = false) {
      if (preview.assessment.issues.some(issue => issue.severity === 'error')) {
        return Promise.reject(new Error('session import: blocking compatibility errors'))
      }
      if (!acknowledgeWarnings && (preview.workspace.warnings.length > 0
        || preview.assessment.issues.some(issue => issue.severity === 'warning'))) {
        return Promise.reject(new Error('session import: warnings require acknowledgment'))
      }
      if (replacementReview !== undefined && !confirmWorkspaceReplacement) {
        return Promise.reject(new Error('session import: replacing the entire existing workspace requires separate confirmation'))
      }
      committed ??= (async () => {
        signal?.throwIfAborted()
        await restoreDshArchiveAttachments(path, preview.manifest, preview, store, stagingParent, policy, signal)
        const preparation = await transfer.commit(true)
        const current = await previewDshWorkspaceImport(preview.manifest.workspace, workspace.path, signal)
        const currentIdentity = current.targetExists ? await stat(cwd, { bigint: true }) : null
        if (!isDeepStrictEqual(current, preview.workspace)
          || identity?.dev !== currentIdentity?.dev || identity?.ino !== currentIdentity?.ino) {
          throw new Error('session import: workspace changed; review again')
        }
        await replacementReview?.verify(signal)
        signal?.throwIfAborted()
        const publish = (destination: string): Promise<AgentHandle> => target.createImportedAgent(preparation, { cwd: destination,
          ...(setup === undefined ? {} : { setup }), ...(signal === undefined ? {} : { signal }) })
        if (workspace.action === 'apply-snapshot') {
          let published: DshArchiveImportResult | undefined
          try {
            return await withDshWorkspaceSnapshot(path, preview.manifest, stagingParent,
              async (directory) => {
                const expected = await fingerprintDshWorkspace(directory, signal)
                if (expected.fingerprint === null) throw new Error('session import: staged workspace fingerprint unavailable')
                const backup = replacementReview === undefined ? undefined
                  : await createDshWorkspaceBackup(cwd, dirname(cwd), { targetSessionId, importId: transfer.lineage.importId }, signal)
                if (backup !== undefined && backup.record.fingerprint !== replacementReview?.metadata.fingerprint) {
                  throw new Error(`session import: workspace changed since review; unused backup retained at ${backup.directory}`)
                }
                const journal = await createDshWorkspaceImportJournal({ targetSessionId, importId: transfer.lineage.importId,
                  sourceSessionId: preview.bundle.context.source.sessionId,
                  sourceDriverId: preview.bundle.context.source.driver.id,
                  targetPath: cwd, expectedFingerprint: expected.fingerprint,
                  ...(backup === undefined ? {} : { backupDirectory: backup.directory }) })
                try {
                  const materialized = async (destination: string): Promise<AgentHandle> => {
                    await journal.record('materialized')
                    signal?.throwIfAborted()
                    return publish(destination)
                  }
                  const handle = backup === undefined ? await withDshNewWorkspace(directory, cwd, materialized, signal)
                    : await withDshWorkspaceReplacement(directory, backup, materialized, signal)
                  published = { handle, workspaceBackup: backup?.directory ?? null, stagingCleanup: null }
                  return published
                } catch (error: unknown) {
                  try { await journal.record(error instanceof AggregateError ? 'rollback-failed' : 'rolled-back') } catch (audit: unknown) {
                    throw new AggregateError([error, audit], 'session import: workspace result could not be persisted; outcome unknown', { cause: error })
                  }
                  throw error
                }
              }, policy, signal)
          } catch (error: unknown) {
            if (published !== undefined && error instanceof DshArchiveStagingCleanupError) {
              return { ...published, stagingCleanup: { path: error.stagingPath, cause: error.cause } }
            }
            throw error
          }
        }
        return { handle: await publish(cwd), workspaceBackup: null, stagingCleanup: null }
      })()
      return committed
    },
  }
}
