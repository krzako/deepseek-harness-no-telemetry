/** Exclusive new-workspace materialization with conservative exception rollback. */

import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fingerprintDshWorkspace } from './workspace-fingerprint.ts'
import { readWorkspaceFileDigest, sameWorkspaceObservation, streamWorkspaceFile } from './workspace-files.ts'

type OwnedEntry = { readonly identity: BigIntStats; readonly source: string | null; readonly completeBytes?: bigint }

function sameIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode
}

async function sourcePrefixMatches(source: string, bytes: number, digest: string): Promise<boolean> {
  const before = await lstat(source, { bigint: true })
  if (!before.isFile() || BigInt(bytes) > before.size) return false
  const hash = createHash('sha256')
  let remaining = bytes
  for await (const chunk of streamWorkspaceFile(source, before)) {
    const count = Math.min(remaining, chunk.length)
    hash.update(chunk.subarray(0, count))
    remaining -= count
  }
  return remaining === 0 && hash.digest('hex') === digest
}

async function rollback(root: string, owned: ReadonlyMap<string, OwnedEntry>): Promise<void> {
  const verified = new Map<string, BigIntStats>()
  const inspect = async (path: string): Promise<void> => {
    const expected = owned.get(path)
    const actual = await lstat(path, { bigint: true })
    if (expected === undefined || !sameIdentity(expected.identity, actual) || await realpath(path) !== path) {
      throw new Error('session import: workspace rollback refused changed identity or foreign entries; workspace retained')
    }
    verified.set(path, actual)
    if (expected.source === null) {
      for (const name of await readdir(path)) await inspect(join(path, name))
    } else {
      const digest = await readWorkspaceFileDigest(path, actual)
      if (expected.completeBytes !== undefined && BigInt(digest.bytes) !== expected.completeBytes
        || !await sourcePrefixMatches(expected.source, digest.bytes, digest.sha256)) {
        throw new Error('session import: workspace rollback refused changed file contents; workspace retained')
      }
    }
  }
  await inspect(root)
  // No recursive deletion until every remaining path is attributable to this attempt.
  for (const [path, expected] of verified) {
    if (!sameWorkspaceObservation(expected, await lstat(path, { bigint: true }))) {
      throw new Error('session import: workspace rollback refused changed identity; workspace retained')
    }
  }
  await rm(root, { recursive: true })
}

/** Materialize a verified private snapshot only into an absent destination.
 * Ordinary failures roll back only observed owned data matching the staged source
 * (including partial copied prefixes). Foreign/changed data refuses rollback.
 * The caller owns private staging through settlement and transactional Session
 * publication. This is not a hostile filesystem sandbox; the caller supplies its recovery journal.
 * @param source - validated private staging directory with ordinary files only.
 * @param target - authorized absolute new directory beneath an existing parent.
 * @param consume - publish the Session after complete materialization; success retains the workspace.
 * @param signal - cancellation through materialization and before publication.
 * @returns the consumer result; failed cleanup throws both errors and retains uncertain data.
 */
export async function withDshNewWorkspace<T>(
  source: string,
  target: string,
  consume: (cwd: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  if (!isAbsolute(target)) throw new Error('session import: new workspace path must be absolute')
  const root = join(await realpath(dirname(target)), basename(target))
  const owned = new Map<string, OwnedEntry>()
  // mkdir without recursive is the exclusive reservation: existing files, links
  // and directories are never adopted, even if they appeared since preview.
  await mkdir(root, { mode: 0o700 })
  try {
    owned.set(root, { identity: await lstat(root, { bigint: true }), source: null })
    const copy = async (from: string, to: string): Promise<void> => {
      for (const name of (await readdir(from)).sort()) {
        signal?.throwIfAborted()
        const parent = owned.get(to)
        if (parent === undefined || !sameIdentity(parent.identity, await lstat(to, { bigint: true }))
          || await realpath(to) !== to) throw new Error('session import: workspace changed during materialization')
        const input = join(from, name)
        const output = join(to, name)
        const before = await lstat(input, { bigint: true })
        if (before.isDirectory()) {
          await mkdir(output, { mode: 0o700 })
          owned.set(output, { identity: await lstat(output, { bigint: true }), source: null })
          await copy(input, output)
        } else if (before.isFile()) {
          const file = await open(output, 'wx', 0o600)
          try {
            owned.set(output, { identity: await file.stat({ bigint: true }), source: input })
            for await (const chunk of streamWorkspaceFile(input, before, signal)) await file.writeFile(chunk)
            await file.sync()
            owned.set(output, { identity: await file.stat({ bigint: true }), source: input, completeBytes: before.size })
          } finally { await file.close() }
        } else throw new Error('session import: staged workspace contains unsupported objects')
      }
    }
    await copy(source, root)
    const expected = await fingerprintDshWorkspace(source, signal)
    const actual = await fingerprintDshWorkspace(root, signal)
    if (expected.fingerprint === null || expected.fingerprint !== actual.fingerprint) {
      throw new Error('session import: workspace changed during materialization')
    }
    for (const [path, entry] of owned) {
      if (!sameIdentity(entry.identity, await lstat(path, { bigint: true })) || await realpath(path) !== path) {
        throw new Error('session import: workspace changed during materialization')
      }
    }
    if (process.platform !== 'win32') {
      for (const path of [...owned].filter(([, entry]) => entry.source === null).map(([path]) => path).reverse().concat(dirname(root))) {
        const directory = await open(path, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    }
    signal?.throwIfAborted()
    return await consume(root)
  } catch (error: unknown) {
    try { await rollback(root, owned) } catch (cleanup: unknown) {
      throw new AggregateError([error, cleanup], 'session import: workspace rollback failed; outcome unknown, inspect retained workspace', { cause: error })
    }
    throw error
  }
}
