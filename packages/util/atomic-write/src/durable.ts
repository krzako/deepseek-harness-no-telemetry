/** Platform durability barriers for explicitly durable atomic replacements. */

import { open } from 'node:fs/promises'
import { resolve, toNamespacedPath } from 'node:path'

type MoveFileExW = (source: string, target: string, flags: number) => number
let native: { move: MoveFileExW; lastError: () => number } | undefined

/** Flush an existing POSIX directory after its namespace changes.
 * @param directory - existing parent of the published file.
 * @returns after the directory flush and handle close.
 */
export async function syncAtomicParent(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Replace a same-volume Windows file using write-through namespace publication.
 * Payload bytes must have been flushed and their handle closed by the caller.
 * No cross-volume copy fallback or deletion of the destination is permitted.
 * @param source - closed, flushed temporary sibling.
 * @param target - destination file to replace.
 * @returns after native publication; rejects with the native error code on failure.
 */
export async function replaceAtomicFileWin32(source: string, target: string): Promise<void> {
  if (native === undefined) {
    const koffi = (await import('koffi')).default
    const kernel = koffi.load('kernel32.dll')
    native = {
      move: kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as MoveFileExW,
      lastError: kernel.func('__stdcall', 'GetLastError', 'uint', []) as () => number,
    }
  }
  // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH; deliberately no COPY_ALLOWED.
  if (native.move(toNamespacedPath(resolve(source)), toNamespacedPath(resolve(target)), 0x1 | 0x8) !== 0) return
  const win32Code = native.lastError()
  const code = win32Code === 5 ? 'EACCES' : win32Code === 32 ? 'EBUSY'
    : win32Code === 17 ? 'EXDEV' : win32Code === 2 || win32Code === 3 ? 'ENOENT' : 'EIO'
  throw Object.assign(new Error(`MoveFileExW failed (${win32Code})`), { code, win32Code, path: source, dest: target })
}
