import { resolve, toNamespacedPath } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { replaceAtomicFileWin32 } from '../src/durable.ts'

const state = vi.hoisted(() => ({ code: 0, move: vi.fn() }))
vi.mock('koffi', () => ({ default: { load: (library: string) => {
  expect(library).toBe('kernel32.dll')
  return { func: (_abi: string, name: string) => name === 'MoveFileExW'
    ? (...args: unknown[]) => { state.move(...args); return state.code === 0 ? 1 : 0 }
    : () => state.code }
} } }))
afterEach(() => { state.code = 0; state.move.mockClear() })

it('uses replace-existing and write-through without copy/delete fallback', async () => {
  await replaceAtomicFileWin32('temporary', 'target')
  expect(state.move).toHaveBeenCalledWith(toNamespacedPath(resolve('temporary')), toNamespacedPath(resolve('target')), 9)
})

it.each([[5, 'EACCES'], [32, 'EBUSY'], [17, 'EXDEV'], [2, 'ENOENT'], [3, 'ENOENT'], [99, 'EIO']] as const)(
  'preserves native failure %s as %s', async (code, expected) => {
    state.code = code
    await expect(replaceAtomicFileWin32('temporary', 'target')).rejects.toMatchObject({ code: expected, win32Code: code })
  },
)
