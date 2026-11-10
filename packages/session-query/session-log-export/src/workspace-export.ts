/** Optional complete workspace snapshots for portable Session exports. */

import type { BigIntStats } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { SessionLogZipEntry } from './archive.ts'
import { isDshArchivePath, type DshArchiveWorkspaceV1 } from './manifest.ts'
import { fingerprintDshWorkspace } from './workspace-fingerprint.ts'
import { sameWorkspaceObservation, streamWorkspaceFile } from './workspace-files.ts'

/** Captured inventory with lazy file reads and a final consistency barrier. */
export interface DshWorkspaceExport {
  readonly metadata: DshArchiveWorkspaceV1
  /** Stream the captured files. @param signal - download cancellation. @returns ordered file entries. */
  entries(signal?: AbortSignal): Generator<SessionLogZipEntry>
  /** Reject changes since capture. @param signal - download cancellation. @returns after verification. */
  verify(signal?: AbortSignal): Promise<void>
}

/** Capture every ordinary file and directory without exclusions or child-link traversal.
 * The caller authorizes the root; this detects concurrent changes, not hostile filesystem races.
 * @param cwd - absolute workspace recorded by the source Session.
 * @param signal - cancellation of traversal and hashing.
 * @returns metadata and bounded file streams; rejects missing or unsupported trees.
 */
export async function captureDshWorkspaceExport(cwd: string | null, signal?: AbortSignal): Promise<DshWorkspaceExport> {
  signal?.throwIfAborted()
  if (cwd === null || !isAbsolute(cwd)) throw new Error('workspace snapshot requires an existing absolute workspace')
  const root = await realpath(cwd)
  const observations = new Map<string, BigIntStats>()
  const directories: string[] = []
  const files: { path: string; absolute: string; before: BigIntStats }[] = []
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted()
    const absolute = join(root, relative)
    const before = await lstat(absolute, { bigint: true })
    const path = relative === '' ? 'workspace' : `workspace/${relative}`
    if (!isDshArchivePath(path)) throw new Error('workspace snapshot contains an unsupported archive path')
    if (before.isSymbolicLink()) throw new Error('workspace snapshot does not support symbolic links')
    if (await realpath(absolute) !== absolute) throw new Error('workspace changed during snapshot capture')
    observations.set(absolute, before)
    if (before.isDirectory()) {
      if (relative !== '') directories.push(path)
      for (const name of (await readdir(absolute)).sort()) await visit(relative === '' ? name : `${relative}/${name}`)
    } else if (before.isFile() && relative !== '') files.push({ path, absolute, before })
    else throw new Error('workspace snapshot requires directories and regular files only')
  }
  const verifyObservations = async (currentSignal?: AbortSignal): Promise<void> => {
    if (await realpath(cwd) !== root) throw new Error('workspace changed during snapshot export')
    for (const [absolute, before] of observations) {
      currentSignal?.throwIfAborted()
      if (!sameWorkspaceObservation(before, await lstat(absolute, { bigint: true }))
        || await realpath(absolute) !== absolute) throw new Error('workspace changed during snapshot export')
    }
  }
  await visit('')
  const fingerprint = await fingerprintDshWorkspace(root, signal)
  if (fingerprint.fingerprint === null) throw new Error('workspace snapshot fingerprint is unavailable')
  await verifyObservations(signal)
  return {
    metadata: { sourceCwd: cwd, ...fingerprint, snapshot: { prefix: 'workspace', complete: true, directories } },
    *entries(currentSignal) {
      for (const file of files) {
        currentSignal?.throwIfAborted()
        yield { path: file.path, chunks: streamWorkspaceFile(file.absolute, file.before, currentSignal) }
      }
    },
    async verify(currentSignal) {
      await verifyObservations(currentSignal)
      const current = await fingerprintDshWorkspace(root, currentSignal)
      if (current.fingerprint !== fingerprint.fingerprint) throw new Error('workspace changed during snapshot export')
      await verifyObservations(currentSignal)
    },
  }
}
