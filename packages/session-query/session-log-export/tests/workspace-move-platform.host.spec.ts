/** Native flags and failure translation; actual non-Linux execution belongs to platform CI. */
import { open } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ move: vi.fn(), errno: vi.fn(), load: vi.fn(), func: vi.fn(), sync: vi.fn(), close: vi.fn() }))
vi.mock('koffi', () => ({ default: { load: native.load, errno: native.errno, os: { errno: { EEXIST: 17, EXDEV: 18, ENOSYS: 38 } } } }))
vi.mock('node:fs/promises', () => ({ open: vi.fn(async () => ({ sync: native.sync, close: native.close })) }))
beforeEach(() => {
  vi.resetModules()
  native.load.mockReturnValue({ func: native.func })
  native.func.mockImplementation((...args: unknown[]) => args.includes('GetLastError') ? native.errno : native.move)
  native.move.mockReturnValue(0)
  native.errno.mockReturnValue(17)
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

it.each(['linux', 'darwin'] as const)('uses native exclusive flags and flushes both parents on %s', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const { moveWorkspacePathExclusive } = await import('../src/workspace-move.ts')
  await moveWorkspacePathExclusive('/from/source', '/to/destination')
  expect(native.move.mock.calls[0]).toEqual(platform === 'linux'
    ? [-100, '/from/source', -100, '/to/destination', 1] : ['/from/source', '/to/destination', 4])
  expect(vi.mocked(open).mock.calls).toEqual([['/from', 'r'], ['/to', 'r']])
  expect(native.sync).toHaveBeenCalledTimes(2)
  expect(native.close).toHaveBeenCalledTimes(2)
})

it.each([17, 18, 38])('propagates POSIX errno %s without falling back or flushing', async (errno) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  native.move.mockReturnValue(-1)
  native.errno.mockReturnValue(errno)
  const { moveWorkspacePathExclusive } = await import('../src/workspace-move.ts')
  await expect(moveWorkspacePathExclusive('/from/source', '/to/destination')).rejects.toMatchObject({ nativeCode: errno })
  expect(native.move).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
})

it('uses Windows write-through without replacement, copy or POSIX directory flush', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  native.move.mockReturnValue(1)
  const { moveWorkspacePathExclusive } = await import('../src/workspace-move.ts')
  await moveWorkspacePathExclusive('/from/source', '/to/destination')
  expect(native.move.mock.calls[0]?.[2]).toBe(8)
  expect(open).not.toHaveBeenCalled()
})

it.each([[183, 'EEXIST'], [17, 'EXDEV'], [5, 'EACCES'], [32, 'EBUSY']])('propagates Windows error %s', async (errno, code) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  native.errno.mockReturnValue(errno)
  const { moveWorkspacePathExclusive } = await import('../src/workspace-move.ts')
  await expect(moveWorkspacePathExclusive('/from/source', '/to/destination')).rejects.toMatchObject({ code, nativeCode: errno })
  expect(native.move).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
})

it('refuses unsupported platforms before loading a native library', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd')
  const { moveWorkspacePathExclusive } = await import('../src/workspace-move.ts')
  await expect(moveWorkspacePathExclusive('/from/source', '/to/destination')).rejects.toThrow('unsupported')
  expect(native.load).not.toHaveBeenCalled()
})
