/** Versioned content fingerprints independent of the workspace's host location. */

import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { readWorkspaceFileDigest, sameWorkspaceObservation } from './workspace-files.ts'

/** SHA-256 over the algorithm name and ordered JSON-line content records. */
export const DSH_WORKSPACE_FINGERPRINT_ALGORITHM = 'dsh-workspace-content-v1' as const

/** Why no content fingerprint can be supplied without inventing workspace fidelity. */
export type DshWorkspaceFingerprintUnavailable = 'not-selected' | 'invalid-path' | 'missing' | 'not-directory' | 'unreadable' | 'unsupported'

/** A versioned digest or an explicit absence, never a partial-tree digest. */
export type DshWorkspaceFingerprint = {
  readonly fingerprint: string
  readonly fingerprintAlgorithm: typeof DSH_WORKSPACE_FINGERPRINT_ALGORITHM
} | {
  readonly fingerprint: null
  readonly fingerprintUnavailable: DshWorkspaceFingerprintUnavailable
}

class UnsupportedWorkspaceEntry extends Error {}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** Fingerprint an authorized workspace without writing or dereferencing child links.
 * Records use depth-first traversal with JavaScript code-unit-sorted names:
 * ["directory", relativePath], ["file", relativePath, bytes, sha256], or
 * ["symlink", relativePath, linkText]. Each JSON record ends with LF; the digest
 * starts with the algorithm name and LF. Root's relative path is empty.
 * File bytes are streamed. All observed paths are checked again before success;
 * detected changes, read failures other than access denial, and cancellation reject.
 * Missing/unreadable/unsupported trees return an explicit unavailable result.
 * Times, ownership, permissions and host location are excluded from the digest.
 * @param path - authorized absolute root, or null when no workspace was selected.
 * @param signal - cancellation of traversal, reads and result publication.
 * @returns complete content fingerprint or its unavailability reason.
 */
export async function fingerprintDshWorkspace(path: string | null, signal?: AbortSignal): Promise<DshWorkspaceFingerprint> {
  signal?.throwIfAborted()
  if (path === null) return { fingerprint: null, fingerprintUnavailable: 'not-selected' }
  if (!isAbsolute(path) || process.platform === 'win32' && ['/', '\\'].includes(parse(path).root)) {
    return { fingerprint: null, fingerprintUnavailable: 'invalid-path' }
  }
  let root: string
  try { root = await realpath(path) } catch (error: unknown) {
    signal?.throwIfAborted()
    if (errorCode(error) === 'ENOENT') return { fingerprint: null, fingerprintUnavailable: 'missing' }
    if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') return { fingerprint: null, fingerprintUnavailable: 'unreadable' }
    throw error
  }
  const observations = new Map<string, BigIntStats>()
  const hash = createHash('sha256').update(`${DSH_WORKSPACE_FINGERPRINT_ALGORITHM}\n`)
  const record = (value: readonly unknown[]): void => { hash.update(`${JSON.stringify(value)}\n`) }
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted()
    const absolute = join(root, relative)
    const before = await lstat(absolute, { bigint: true })
    observations.set(absolute, before)
    if (before.isSymbolicLink()) record(['symlink', relative, await readlink(absolute)])
    else if (before.isDirectory()) {
      if (await realpath(absolute) !== absolute) throw new Error('workspace changed during inspection')
      record(['directory', relative])
      const names = (await readdir(absolute)).sort()
      for (const name of names) await visit(relative === '' ? name : `${relative}/${name}`)
    } else if (before.isFile()) {
      const file = await readWorkspaceFileDigest(absolute, before, signal)
      record(['file', relative, file.bytes, file.sha256])
    } else throw new UnsupportedWorkspaceEntry()
  }
  try {
    if (!(await lstat(root)).isDirectory()) return { fingerprint: null, fingerprintUnavailable: 'not-directory' }
    await visit('')
    for (const [absolute, before] of observations) {
      signal?.throwIfAborted()
      if (!sameWorkspaceObservation(before, await lstat(absolute, { bigint: true }))) {
        throw new Error('workspace changed during inspection')
      }
    }
    signal?.throwIfAborted()
    return { fingerprint: hash.digest('hex'), fingerprintAlgorithm: DSH_WORKSPACE_FINGERPRINT_ALGORITHM }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (error instanceof UnsupportedWorkspaceEntry) return { fingerprint: null, fingerprintUnavailable: 'unsupported' }
    if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') return { fingerprint: null, fingerprintUnavailable: 'unreadable' }
    throw error
  }
}
