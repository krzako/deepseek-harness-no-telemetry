/** Shared stable observations and streamed hashes for authorized workspace reads. */

import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'

/** Compare filesystem observations to detect replacement or mutation during a read.
 * @param before - observation before reading.
 * @param after - observation after reading.
 * @returns whether identity, type, size and modification metadata remain unchanged.
 */
export function sameWorkspaceObservation(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

/** Hash a regular file without following a link substituted at its path.
 * This observes an authorized directory tree; it is not an adversarial filesystem sandbox.
 * @param path - canonical absolute file path whose parents were checked by the caller.
 * @param before - lstat observation identifying the expected regular file.
 * @param signal - cancellation of streamed reads.
 * @returns measured bytes and SHA-256 after identity and mutation checks; always closes the handle.
 */
export async function readWorkspaceFileDigest(path: string, before: BigIntStats, signal?: AbortSignal)
  : Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const data of streamWorkspaceFile(path, before, signal)) {
    bytes += data.length
    if (!Number.isSafeInteger(bytes)) throw new Error('workspace file exceeds safe byte count')
    hash.update(data)
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** Stream a regular file while checking identity and mutation before and after reading.
 * @param path - canonical file path beneath an authorized, observed workspace.
 * @param before - expected regular-file observation.
 * @param signal - cancellation of reads.
 * @returns bounded byte chunks; closes the handle on completion, cancellation or consumer return.
 */
export async function* streamWorkspaceFile(path: string, before: BigIntStats, signal?: AbortSignal): AsyncGenerator<Buffer> {
  signal?.throwIfAborted()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat({ bigint: true })
    if (!opened.isFile() || !sameWorkspaceObservation(before, opened) || await realpath(path) !== path) {
      throw new Error('workspace changed during inspection')
    }
    for await (const chunk of file.createReadStream({ autoClose: false, signal, highWaterMark: 64 * 1024 })) {
      signal?.throwIfAborted()
      yield chunk as Buffer
    }
    const after = await file.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (!sameWorkspaceObservation(opened, after) || !sameWorkspaceObservation(opened, current)
      || await realpath(path) !== path) throw new Error('workspace changed during inspection')
    signal?.throwIfAborted()
  } finally { await file.close() }
}
