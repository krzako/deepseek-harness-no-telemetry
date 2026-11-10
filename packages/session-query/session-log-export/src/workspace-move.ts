/** Native no-replace moves used by workspace replacement and rollback. */
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, toNamespacedPath } from 'node:path'

type NativeMove = (source: string, destination: string) => void
let binding: Promise<NativeMove> | undefined

/** The move succeeded, but a later POSIX directory flush failed; do not repeat blindly. */
export class DshWorkspaceMoveDurabilityError extends Error {
  /** The native move completed before the durability failure. */
  readonly moved = true
  /** Published destination requiring transaction-level inspection. */
  readonly destination: string

  constructor(destination: string, cause: unknown) {
    super('workspace move completed but directory flush failed; inspect transaction state', { cause })
    this.name = 'DshWorkspaceMoveDurabilityError'
    this.destination = destination
  }
}

async function loadMove(): Promise<NativeMove> {
  const platform = process.platform
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`workspace move: no-replace is unsupported on ${platform}`)
  const koffi = (await import('koffi')).default
  if (platform === 'win32') {
    const kernel = koffi.load('kernel32.dll')
    const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as (source: string, target: string, flags: number) => number
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint', []) as () => number
    return (source, destination) => {
      // WRITE_THROUGH only: neither replacement nor cross-volume copying is permitted.
      if (move(toNamespacedPath(source), toNamespacedPath(destination), 0x8) !== 0) return
      const nativeCode = lastError()
      const code = nativeCode === 80 || nativeCode === 183 ? 'EEXIST' : nativeCode === 17 ? 'EXDEV'
        : nativeCode === 2 || nativeCode === 3 ? 'ENOENT' : nativeCode === 5 ? 'EACCES' : nativeCode === 32 ? 'EBUSY' : 'EIO'
      throw Object.assign(new Error(`workspace move: MoveFileExW failed (${nativeCode})`), { code, nativeCode, path: source, dest: destination })
    }
  }
  const libc = koffi.load(null)
  const rename = platform === 'linux'
    ? libc.func('int renameat2(int, str, int, str, uint)') as (fromFd: number, from: string, toFd: number, to: string, flags: number) => number
    : libc.func('int renamex_np(str, str, uint)') as (from: string, to: string, flags: number) => number
  return (source, destination) => {
    const result = platform === 'linux'
      ? (rename as (fromFd: number, from: string, toFd: number, to: string, flags: number) => number)(-100, source, -100, destination, 1)
      : (rename as (from: string, to: string, flags: number) => number)(source, destination, 4)
    if (result === 0) return
    const nativeCode = koffi.errno()
    const code = Object.entries(koffi.os.errno).find(([, value]) => value === nativeCode)?.[0] ?? 'EIO'
    throw Object.assign(new Error(`workspace move: native no-replace failed (${code})`), { code, nativeCode, path: source, dest: destination })
  }
}

/** Move an authorized path atomically only when the destination does not exist.
 * No copy/delete or ordinary-rename fallback is allowed. Payload flushing and
 * transaction journaling belong to the caller. POSIX flushes both parents after
 * success; Windows requests native write-through. A flush failure reports moved.
 * This protects the destination, not against hostile replacement of ancestors or
 * the source; callers retain and inspect uncertain effects after other I/O errors.
 * @param source - absolute existing path on the destination's volume.
 * @param destination - absolute absent path beneath an existing parent.
 * @returns after no-replace publication and platform namespace barriers.
 */
export async function moveWorkspacePathExclusive(source: string, destination: string): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(destination) || source.includes('\0') || destination.includes('\0')) {
    throw new Error('workspace move: absolute paths without NUL required')
  }
  const from = resolve(source)
  const to = resolve(destination)
  if (from === to) throw new Error('workspace move: distinct source and destination required')
  const move = await (binding ??= loadMove())
  move(from, to)
  if (process.platform !== 'win32') {
    try {
      for (const parent of new Set([dirname(from), dirname(to)])) {
        const handle = await open(parent, 'r')
        try { await handle.sync() } finally { await handle.close() }
      }
    } catch (error: unknown) { throw new DshWorkspaceMoveDurabilityError(to, error) }
  }
}
