/** Replace an authorized workspace while retaining its original tree and verified content backup. */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { BigIntStats } from 'node:fs'
import { inspectDshWorkspaceBackup, type DshWorkspaceBackup } from './workspace-backup.ts'
import { captureDshWorkspaceExport } from './workspace-export.ts'
import { withDshNewWorkspace } from './new-workspace.ts'
import { DshWorkspaceMoveDurabilityError, moveWorkspacePathExclusive } from './workspace-move.ts'

function sameDirectory(actual: BigIntStats, expected: { readonly dev: string; readonly ino: string }): boolean {
  return actual.isDirectory() && String(actual.dev) === expected.dev && String(actual.ino) === expected.ino
}

/** Install a complete snapshot after a separately confirmed, verified backup.
 * A caller-owned durable intent must name the backup before this function starts.
 * The original tree remains at backup/original after success, preserving metadata
 * beyond the content copy. Ordinary failure restores it only without overwriting
 * another destination or removing changed replacement data; uncertainty retains
 * both trees and throws an AggregateError. This assumes cooperative local paths.
 * @param snapshot - private verified snapshot, retained through settlement.
 * @param backup - ready content backup bound to the reviewed source and import.
 * @param consume - durably record materialization and publish the new Session.
 * @param signal - cancellation before publication, never after successful consume.
 * @returns the publication result; the caller owns the retained backup directory.
 */
export async function withDshWorkspaceReplacement<T>(
  snapshot: string,
  backup: DshWorkspaceBackup,
  consume: (cwd: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const checked = await inspectDshWorkspaceBackup(backup.directory, signal)
  if (checked.record.state !== 'ready' || !isDeepStrictEqual(checked, backup)) {
    throw new Error('workspace replacement: backup changed or is incomplete')
  }
  const target = backup.record.sourcePath
  const original = join(backup.directory, 'original')
  const candidate = join(backup.directory, 'replacement')
  return withDshNewWorkspace(snapshot, candidate, async () => {
    const source = await captureDshWorkspaceExport(target, signal)
    if (source.metadata.fingerprint !== backup.record.fingerprint
      || !sameDirectory(await lstat(target, { bigint: true }), backup.record.sourceIdentity)) {
      throw new Error('workspace replacement: source changed since backup')
    }
    const replacement = await captureDshWorkspaceExport(candidate, signal)
    const candidateStat = await lstat(candidate, { bigint: true })
    const candidateIdentity = { dev: String(candidateStat.dev), ino: String(candidateStat.ino) }
    await source.verify(signal)
    const state = { displaced: false, installed: false }
    try {
      signal?.throwIfAborted()
      try { await moveWorkspacePathExclusive(target, original); state.displaced = true } catch (error: unknown) {
        if (error instanceof DshWorkspaceMoveDurabilityError) { state.displaced = true; throw error }
        throw new AggregateError([error], 'workspace replacement: displacement failed; outcome unknown, inspect backup', { cause: error })
      }
      const movedSource = await captureDshWorkspaceExport(original, signal)
      if (movedSource.metadata.fingerprint !== backup.record.fingerprint
        || !sameDirectory(await lstat(original, { bigint: true }), backup.record.sourceIdentity)) {
        throw new Error('workspace replacement: source changed during displacement')
      }
      signal?.throwIfAborted()
      try { await moveWorkspacePathExclusive(candidate, target); state.installed = true } catch (error: unknown) {
        if (error instanceof DshWorkspaceMoveDurabilityError) { state.installed = true; throw error }
        throw new AggregateError([error], 'workspace replacement: installation failed; outcome unknown, inspect backup', { cause: error })
      }
      signal?.throwIfAborted()
      return await consume(target)
    } catch (error: unknown) {
      try {
        if (state.installed) {
          const current = await captureDshWorkspaceExport(target)
          if (current.metadata.fingerprint !== replacement.metadata.fingerprint
            || !sameDirectory(await lstat(target, { bigint: true }), candidateIdentity)) {
            throw new Error('workspace replacement: changed replacement retained')
          }
          await moveWorkspacePathExclusive(target, candidate)
        }
        if (state.displaced) await moveWorkspacePathExclusive(original, target)
      } catch (rollback: unknown) {
        throw new AggregateError([error, rollback], `workspace replacement: rollback failed; outcome unknown; backup retained at ${backup.directory}`, { cause: error })
      }
      throw error
    }
  }, signal)
}
