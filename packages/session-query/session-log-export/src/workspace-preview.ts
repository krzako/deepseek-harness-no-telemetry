/** Read-only workspace choices for portable archive import. */

import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, parse } from 'node:path'
import type { DshArchiveWorkspaceV1 } from './manifest.ts'
import { fingerprintDshWorkspace } from './workspace-fingerprint.ts'

/** One permitted import choice; applying it belongs to the import transaction. */
export interface DshWorkspaceImportChoice {
  readonly action: 'keep-workspace' | 'apply-snapshot' | 'context-only'
  readonly fidelity: 'unverified' | 'snapshot-content' | 'missing'
  readonly separateConfirmation: boolean
  readonly recoverableBackup: boolean
  readonly needsWorkspaceBeforeTurn: boolean
}

/** Observed destination and available choices; no choice is executed or selected implicitly. */
export interface DshWorkspaceImportPreview {
  readonly targetPath: string | null
  readonly targetExists: boolean
  readonly sourceFingerprint: string | null
  readonly targetFingerprint: string | null
  readonly fingerprintComparison: 'matching-content' | 'different-content' | 'unverified'
  readonly warnings: readonly ('workspace-unverified' | 'workspace-missing' | 'snapshot-replaces-files'
    | 'workspace-destination-required' | 'snapshot-directories-unrecorded')[]
  readonly choices: readonly DshWorkspaceImportChoice[]
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path) } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  return true
}

/** Inspect an authorized target directory and expose the four workspace import cases.
 * Existing directories are canonicalized; missing paths remain explicit and
 * nothing is created. A file target, relative path or filesystem access failure
 * rejects. A recognized content-fingerprint algorithm compares target content;
 * legacy digests remain unverified. Matching content does not verify permissions
 * or other environment metadata, so keeping files retains unverified fidelity.
 * Snapshot fidelity describes its contents only after a separate successful
 * application, not current files or source metadata such as permissions. Older
 * snapshots without directory inventories retain unverified fidelity.
 * The caller must recheck the destination in the later import transaction.
 * @param workspace - workspace declaration from a fully verified archive.
 * @param targetPath - authorized fully qualified destination, or no chosen workspace.
 * @param signal - cancellation before successful result publication.
 * @returns observations, warnings and explicit choices without filesystem writes.
 */
export async function previewDshWorkspaceImport(
  workspace: DshArchiveWorkspaceV1,
  targetPath: string | null,
  signal?: AbortSignal,
): Promise<DshWorkspaceImportPreview> {
  signal?.throwIfAborted()
  let canonical = targetPath
  let exists = false
  if (targetPath !== null) {
    const root = parse(targetPath).root
    if (!isAbsolute(targetPath) || process.platform === 'win32' && (root === '\\' || root === '/')) {
      throw new Error('session import: workspace path must be fully qualified')
    }
    if (await pathExists(targetPath)) {
      const resolved = await realpath(targetPath)
      if (!(await stat(resolved)).isDirectory()) throw new Error('session import: workspace target is not a directory')
      canonical = resolved
      exists = true
    }
  }
  signal?.throwIfAborted()
  const warnings: DshWorkspaceImportPreview['warnings'][number][] = [exists ? 'workspace-unverified' : 'workspace-missing']
  const choices: DshWorkspaceImportChoice[] = exists || workspace.snapshot === null ? [{
    action: exists ? 'keep-workspace' : 'context-only', fidelity: exists ? 'unverified' : 'missing',
    separateConfirmation: false, recoverableBackup: false, needsWorkspaceBeforeTurn: !exists,
  }] : []
  if (workspace.snapshot !== null && targetPath !== null) {
    choices.push({ action: 'apply-snapshot', fidelity: workspace.snapshot.directories === undefined ? 'unverified' : 'snapshot-content',
      separateConfirmation: exists,
      recoverableBackup: exists, needsWorkspaceBeforeTurn: false })
    if (exists) warnings.push('snapshot-replaces-files')
  }
  if (workspace.snapshot !== null && workspace.snapshot.directories === undefined) warnings.push('snapshot-directories-unrecorded')
  if (workspace.snapshot !== null && targetPath === null) warnings.push('workspace-destination-required')
  const target = exists && workspace.fingerprintAlgorithm === 'dsh-workspace-content-v1'
    ? await fingerprintDshWorkspace(canonical, signal) : { fingerprint: null }
  const fingerprintComparison = target.fingerprint === null || workspace.fingerprint === null ? 'unverified'
    : target.fingerprint === workspace.fingerprint ? 'matching-content' : 'different-content'
  return { targetPath: canonical, targetExists: exists, sourceFingerprint: workspace.fingerprint,
    targetFingerprint: target.fingerprint, fingerprintComparison, warnings, choices }
}
