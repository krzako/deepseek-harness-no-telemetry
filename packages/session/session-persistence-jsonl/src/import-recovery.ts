/** Conservative inspection and cleanup of interrupted JSONL imports. */

import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { discardEmptyImportFence, hasImportFence, IMPORT_PENDING } from './import-transaction.ts'
import { LEASE_FILENAME, SessionWriteLease } from './lease.ts'

/** Read-only observation; neither file completeness nor absence of a live owner is inferred. */
export interface JsonlPendingImport {
  readonly sessionId: SessionId
  readonly revision: SessionPersistenceRevision
  readonly outcome: 'unknown'
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[]
  /** True only for the pending marker and optional stable kernel-lock file. */
  readonly empty: boolean
}

/** Read every pending-import byte without changing or repairing it.
 * Concurrent mutations reject rather than produce a reusable cleanup observation.
 * @param directory - backend-resolved Session directory.
 * @param sessionId - its validated logical identity.
 * @param signal - cancellation during inspection.
 * @returns a detached inventory, or undefined when the pending fence is absent.
 */
export async function inspectJsonlPendingImport(
  directory: string, sessionId: SessionId, signal?: AbortSignal,
): Promise<JsonlPendingImport | undefined> {
  signal?.throwIfAborted()
  if (!await hasImportFence(directory)) return undefined
  const identity = await lstat(directory, { bigint: true })
  if (!identity.isDirectory()) throw new Error('import recovery requires a real Session directory')
  const names = (await readdir(directory)).filter(name => name !== LEASE_FILENAME).sort()
  const files: { name: string; bytes: number; sha256: string }[] = []
  const revision = createHash('sha256').update(JSON.stringify([directory, String(identity.dev), String(identity.ino)]))
  for (const name of names) {
    signal?.throwIfAborted()
    const path = join(directory, name)
    const before = await lstat(path, { bigint: true })
    if (!before.isFile()) throw new Error('import recovery refuses non-regular artifacts')
    const handle = await open(path, 'r')
    const digest = createHash('sha256')
    let bytes = 0
    try {
      const opened = await handle.stat({ bigint: true })
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('import changed during inspection')
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        signal?.throwIfAborted()
        const read = await handle.read(buffer, 0, buffer.length, null)
        if (read.bytesRead === 0) break
        bytes += read.bytesRead
        digest.update(buffer.subarray(0, read.bytesRead))
      }
      const after = await lstat(path, { bigint: true })
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || BigInt(bytes) !== before.size) {
        throw new Error('import changed during inspection')
      }
      revision.update(JSON.stringify([name, String(before.ino), String(before.mtimeNs), String(before.ctimeNs)]))
    } finally { await handle.close() }
    files.push({ name, bytes, sha256: digest.digest('hex') })
  }
  const currentNames = (await readdir(directory)).filter(name => name !== LEASE_FILENAME).sort()
  if (JSON.stringify(names) !== JSON.stringify(currentNames) || !await hasImportFence(directory)) {
    throw new Error('import changed during inspection')
  }
  signal?.throwIfAborted()
  revision.update(JSON.stringify(files))
  return { sessionId, revision: SessionPersistenceRevision(revision.digest('hex')), outcome: 'unknown', files,
    empty: names.length === 1 && names[0] === IMPORT_PENDING
      && files[0]?.sha256 === createHash('sha256').update('DSH import pending v1\n').digest('hex') }
}

/** Resolve an explicitly reviewed interruption only after acquiring its kernel lease.
 * Nonempty imports can only be retained, still hidden and reserved, for manual audit
 * and a fresh import to a new ID. Only a marker without any other artifact may be
 * removed. No log, uncertain audit, attachment, workspace or lock inode is deleted.
 * @param directory - backend-resolved Session directory.
 * @param expected - read-only observation whose revision must still match.
 * @param action - explicit retain-data or discard-empty choice.
 * @param signal - cancellation before the cleanup commit.
 * @returns retained data with unknown outcome, or confirmation of empty cleanup.
 */
export async function recoverJsonlPendingImport(
  directory: string, expected: JsonlPendingImport, action: 'retain' | 'discard-empty', signal?: AbortSignal,
): Promise<'retained-outcome-unknown' | 'discarded-empty'> {
  signal?.throwIfAborted()
  const lease = await SessionWriteLease.acquire(directory, expected.sessionId)
  try {
    const current = await inspectJsonlPendingImport(directory, expected.sessionId, signal)
    if (current === undefined || current.revision !== expected.revision) throw new Error('import recovery requires a fresh report')
    if (action === 'retain') return 'retained-outcome-unknown'
    if (!current.empty) throw new Error('import recovery refuses to discard data with outcome unknown')
    signal?.throwIfAborted()
    await discardEmptyImportFence(directory)
    return 'discarded-empty'
  } finally { await lease.release() }
}
