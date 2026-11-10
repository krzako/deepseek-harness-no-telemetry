/** Durable visibility boundary for a fresh JSONL import under its existing write lease. */

import { open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isPromise } from 'node:util/types'
import type { SessionHandle, SessionImportTransaction } from '@deepseek-ai/dsh-session-persistence'
import { SessionWriteLease } from './lease.ts'
import { publishNewFileWin32 } from './win32.ts'

/** Presence hides every generation in this directory, including after a crash. */
export const IMPORT_PENDING = '.dsh-import-pending'
const IMPORT_COMMITTED = '.dsh-import-committed'

/** Check the durable visibility fence; unexpected filesystem errors must propagate.
 * @param directory - Session directory to inspect.
 * @returns whether the import is still unpublished.
 */
export async function hasImportFence(directory: string): Promise<boolean> {
  try { await stat(join(directory, IMPORT_PENDING)); return true } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return // Windows namespace changes use MOVEFILE_WRITE_THROUGH below.
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function moveDurably(source: string, target: string): Promise<void> {
  if (process.platform === 'win32') await publishNewFileWin32(source, target)
  else { await rename(source, target); await syncDirectory(dirname(target)) }
}

/** Create the pending fence before any log bytes exist, under exclusive ownership.
 * @param directory - existing private Session directory protected by its write lease.
 */
export async function createImportFence(directory: string): Promise<void> {
  const temporary = join(directory, `.dsh-import-marker-${randomUUID()}`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile('DSH import pending v1\n'); await handle.sync() } finally { await handle.close() }
    await moveDurably(temporary, join(directory, IMPORT_PENDING))
  } finally { await rm(temporary, { force: true }) }
}

/** Remove an exclusively leased, verified empty reservation durably.
 * @param directory - Session directory containing no data besides its marker and lock.
 */
export async function discardEmptyImportFence(directory: string): Promise<void> {
  const discarded = join(directory, `.dsh-import-discarded-${randomUUID()}`)
  await moveDurably(join(directory, IMPORT_PENDING), discarded)
  await rm(discarded)
  await syncDirectory(directory)
}

/** Own the hidden log through a single serialized publication/rollback boundary.
 * Unfinished imports remain fenced across process death; they are never guessed
 * complete or automatically replayed. Rollback removes only this new import's log,
 * preserving the stable lock inode and every pre-existing committed Session.
 * @param handle - exclusively owned fresh import write handle.
 * @param log - this transaction's single current-generation log path.
 * @returns transaction with observable cleanup failures.
 */
export function jsonlImportTransaction(handle: SessionHandle, log: string): SessionImportTransaction {
  const directory = dirname(log)
  const pending = join(directory, IMPORT_PENDING)
  const committed = join(directory, IMPORT_COMMITTED)
  let state: 'pending' | 'published' | 'rolled-back' = 'pending'
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = chain.then(operation)
    chain = next.catch(() => {})
    return next
  }
  const hide = async (): Promise<void> => {
    if (await hasImportFence(directory)) return
    await moveDurably(committed, pending)
  }
  return {
    handle,
    publish<T>(publish: () => T): Promise<T> {
      return enqueue(async () => {
        if (state !== 'pending') throw new Error('import transaction has already settled')
        await handle.flush()
        try {
          await moveDurably(pending, committed)
          const result = publish()
          if (isPromise(result)) throw new Error('import publication callback must be synchronous')
          state = 'published'
          return result
        } catch (error: unknown) {
          try { await hide() } catch (cleanup: unknown) {
            throw new AggregateError([error, cleanup], 'import publication failed and its visibility fence could not be restored')
          }
          throw error
        }
      })
    },
    rollback(): Promise<void> {
      return enqueue(async () => {
        if (state === 'rolled-back') return
        if (state === 'published') throw new Error('cannot roll back a published import')
        // Restore the fence before close releases the original write lease.
        await hide()
        const failures: unknown[] = []
        try { await handle.close() } catch (error: unknown) { failures.push(error) }
        const lease = await SessionWriteLease.acquire(directory, handle.id)
        try {
          // A durable rename removes the uncommitted log from the generation namespace
          // before cleanup. A crash may retain a discarded file, never a resumable log.
          const discarded = join(directory, `.dsh-import-discarded-${randomUUID()}`)
          try { await moveDurably(log, discarded) } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          await rm(discarded, { force: true })
          await moveDurably(pending, discarded)
          await rm(discarded, { force: true })
          await syncDirectory(directory)
          state = 'rolled-back'
        } catch (error: unknown) { failures.push(error) }
        finally { try { await lease.release() } catch (error: unknown) { failures.push(error) } }
        if (failures.length > 0) throw new AggregateError(failures, 'import rollback could not completely clean up its stored Session')
      })
    },
  }
}
