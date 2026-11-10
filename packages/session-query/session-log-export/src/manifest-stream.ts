/** Measure archive entries as the ZIP writer consumes them, then validate the final manifest. */

import { createHash } from 'node:crypto'
import type { SessionLogZipEntry } from './archive.ts'
import {
  DSH_SESSION_ARCHIVE_VERSION, isDshSessionArchiveManifestV1,
  type DshArchiveEntryV1, type DshSessionArchiveManifestV1,
} from './manifest.ts'

/** Optional operator limits for uncompressed entries in one portable archive. */
export interface DshArchiveResourcePolicy {
  readonly maxEntryBytes?: number
  readonly maxTotalUncompressedBytes?: number
}

/** Per-archive byte accounting shared by its sequential measured entries. */
export interface DshArchiveResourceBudget {
  /** Refuse an over-limit chunk before it enters the ZIP writer. */
  accept(path: string, entryBytes: number, addedBytes: number): void
}

/**
 * Create an opt-in byte budget; absent limits leave archive size unrestricted.
 * @param policy - safe-integer limits selected by the operator.
 * @returns one budget to share across all entries of a portable archive.
 */
export function createDshArchiveResourceBudget(policy: DshArchiveResourcePolicy = {}): DshArchiveResourceBudget {
  for (const limit of [policy.maxEntryBytes, policy.maxTotalUncompressedBytes]) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new RangeError('portable archive resource limits must be positive safe integers')
    }
  }
  let total = 0
  return {
    accept(path, entryBytes, addedBytes) {
      if (!Number.isSafeInteger(entryBytes) || entryBytes < 0
        || !Number.isSafeInteger(addedBytes) || addedBytes < 0
        || !Number.isSafeInteger(total + addedBytes)) {
        throw new Error(`archive entry ${path} exceeds safe byte count`)
      }
      if (policy.maxEntryBytes !== undefined && entryBytes > policy.maxEntryBytes) {
        throw new Error(`archive entry ${path} exceeds configured maxEntryBytes`)
      }
      if (policy.maxTotalUncompressedBytes !== undefined
        && total + addedBytes > policy.maxTotalUncompressedBytes) {
        throw new Error(`portable archive exceeds configured maxTotalUncompressedBytes at ${path}`)
      }
      total += addedBytes
    },
  }
}

/** One ZIP payload and its receipt, available only after complete consumption. */
export interface MeasuredDshArchiveEntry {
  readonly entry: SessionLogZipEntry
  /** @returns hash and byte count; throws until the entire payload has been consumed. */
  receipt(): DshArchiveEntryV1
}

/**
 * Wrap an entry without buffering streamed attachment bytes. A partial or failed
 * stream has no receipt and cannot enter a valid manifest.
 * @param entry - source ZIP entry in its original byte order.
 * @param kind - manifest classification of this entry.
 * @param budget - optional shared operator budget for uncompressed bytes.
 * @returns entry for the ZIP writer and a completion-dependent receipt.
 */
export function measureDshArchiveEntry(
  entry: SessionLogZipEntry,
  kind: DshArchiveEntryV1['kind'],
  budget?: DshArchiveResourceBudget,
): MeasuredDshArchiveEntry {
  let completed: DshArchiveEntryV1 | undefined
  const finish = (bytes: number, sha256: string): DshArchiveEntryV1 => ({
    path: entry.path, kind, bytes, sha256,
  })
  if ('content' in entry) {
    const receipt = finish(Buffer.byteLength(entry.content), createHash('sha256').update(entry.content, 'utf8').digest('hex'))
    budget?.accept(entry.path, receipt.bytes, receipt.bytes)
    return { entry, receipt: () => receipt }
  }
  if ('data' in entry) {
    const receipt = finish(entry.data.byteLength, createHash('sha256').update(entry.data).digest('hex'))
    budget?.accept(entry.path, receipt.bytes, receipt.bytes)
    return { entry, receipt: () => receipt }
  }
  const chunks = entry.chunks
  return {
    entry: {
      path: entry.path,
      chunks: (async function* () {
        const hash = createHash('sha256')
        let bytes = 0
        for await (const chunk of chunks) {
          bytes += chunk.byteLength
          if (!Number.isSafeInteger(bytes)) throw new Error(`archive entry ${entry.path} exceeds safe byte count`)
          budget?.accept(entry.path, bytes, chunk.byteLength)
          hash.update(chunk)
          yield chunk
        }
        completed = finish(bytes, hash.digest('hex'))
      })(),
    },
    receipt: () => {
      if (completed === undefined) throw new Error(`archive entry ${entry.path} was not completely consumed`)
      return completed
    },
  }
}

/**
 * Construct a manifest only from completed entry receipts and reject inconsistent paths.
 * @param input - root identity, required payload paths, and workspace description.
 * @param entries - receipts returned after complete ZIP-entry consumption.
 * @returns validated manifest to serialize as the final ZIP entry.
 */
export function completeDshArchiveManifestV1(
  input: Omit<DshSessionArchiveManifestV1, 'version' | 'entries'>,
  entries: readonly DshArchiveEntryV1[],
): DshSessionArchiveManifestV1 {
  const manifest = { version: DSH_SESSION_ARCHIVE_VERSION, ...input, entries }
  if (!isDshSessionArchiveManifestV1(manifest)) throw new Error('session export: invalid archive manifest')
  return manifest
}
