/** Read-only comparison of verified snapshot entries with an authorized destination. */

import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshSessionArchiveManifestV1 } from './manifest.ts'
import { readWorkspaceFileDigest } from './workspace-files.ts'

/** Comparison of one snapshot entry, without a promise about other workspace files. */
export interface DshWorkspaceEntryComparison {
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly status: 'new' | 'identical' | 'changed' | 'directory-present' | 'type-conflict' | 'parent-conflict'
  /** Workspace-relative blocking path, present for a type or parent conflict. */
  readonly conflictPath?: string
}

async function inspect(path: string) {
  try { return await lstat(path, { bigint: true }) } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function checkRoot(root: string): Promise<void> {
  const info = await lstat(root)
  if (!info.isDirectory() || await realpath(root) !== root) throw new Error('session import: workspace changed during preview')
}

async function compareEntry(root: string, entry: { path: string; kind: 'file' | 'directory'; bytes?: number; sha256?: string }, signal?: AbortSignal)
  : Promise<DshWorkspaceEntryComparison> {
  const { path, kind } = entry
  await checkRoot(root)
  const segments = path.split('/')
  for (let count = 1; count < segments.length; count++) {
    const parent = segments.slice(0, count).join('/')
    const info = await inspect(join(root, parent))
    if (info === null) return { path, kind, status: 'new' }
    if (!info.isDirectory()) return { path, kind, status: 'parent-conflict', conflictPath: parent }
  }
  const destination = join(root, path)
  const before = await inspect(destination)
  if (before === null) return { path, kind, status: 'new' }
  if (kind === 'directory') {
    await checkRoot(root)
    return before.isDirectory() ? { path, kind, status: 'directory-present' }
      : { path, kind, status: 'type-conflict', conflictPath: path }
  }
  if (!before.isFile()) return { path, kind, status: 'type-conflict', conflictPath: path }
  const digest = await readWorkspaceFileDigest(destination, before, signal)
  await checkRoot(root)
  return { path, kind, status: digest.bytes === entry.bytes && digest.sha256 === entry.sha256 ? 'identical' : 'changed' }
}

/** Compare files and directories declared by a verified snapshot, without writing or following links.
 * Links and mismatched destination types are conflicts, including links in parent paths.
 * Access errors, detected concurrent changes and cancellation reject the result.
 * Directory presence means only matching type; its contents are not compared here.
 * Extra destination files and filesystem metadata are not compared; this does not
 * establish whole-workspace fidelity or authorize later writes. The import
 * transaction must revalidate the destination before applying a snapshot.
 * @param manifest - fully validated archive inventory, captured before asynchronous reads.
 * @param targetPath - canonical authorized existing directory, or null for an absent destination.
 * @param signal - cancellation of file reads and result publication.
 * @returns one typed comparison per declared snapshot entry, or null when there is no snapshot.
 */
export async function compareDshWorkspaceSnapshot(
  manifest: DshSessionArchiveManifestV1,
  targetPath: string | null,
  signal?: AbortSignal,
): Promise<readonly DshWorkspaceEntryComparison[] | null> {
  signal?.throwIfAborted()
  if (manifest.workspace.snapshot === null) return null
  const prefix = `${manifest.workspace.snapshot.prefix}/`
  const entries = manifest.entries.filter(entry => entry.kind === 'workspace').map(entry => ({
    path: entry.path.slice(prefix.length), kind: 'file' as const, bytes: entry.bytes, sha256: entry.sha256,
  }))
  const result: DshWorkspaceEntryComparison[] = []
  const directories = (manifest.workspace.snapshot.directories ?? []).map(path => ({
    path: path.slice(prefix.length), kind: 'directory' as const,
  }))
  for (const entry of [...directories, ...entries]) {
    signal?.throwIfAborted()
    result.push(targetPath === null ? { path: entry.path, kind: entry.kind, status: 'new' }
      : await compareEntry(targetPath, entry, signal))
  }
  signal?.throwIfAborted()
  return result
}
