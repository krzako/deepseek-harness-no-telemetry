import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withDshNewWorkspace } from '../src/new-workspace.ts'
import { fingerprintDshWorkspace } from '../src/workspace-fingerprint.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-new-workspace-'))
  roots.push(parent)
  const source = join(parent, 'source')
  await mkdir(join(source, 'empty'), { recursive: true })
  await writeFile(join(source, '.binary'), Buffer.from([0, 255, 17]))
  return { parent, source, target: join(parent, 'target') }
}

it('materializes all content before publication and retains it after success', async () => {
  const { source, target } = await fixture()
  const result = await withDshNewWorkspace(source, target, async (cwd) => {
    expect(cwd).toBe(target)
    expect(await fingerprintDshWorkspace(cwd)).toEqual(await fingerprintDshWorkspace(source))
    expect(await readdir(join(cwd, 'empty'))).toEqual([])
    return 'published'
  })
  expect(result).toBe('published')
  expect(await readFile(join(target, '.binary'))).toEqual(Buffer.from([0, 255, 17]))
})

it('exclusively reserves the destination and never adopts an existing directory, file or link', async () => {
  const { source, target } = await fixture()
  const publish = vi.fn()
  await mkdir(target)
  await expect(withDshNewWorkspace(source, target, publish)).rejects.toMatchObject({ code: 'EEXIST' })
  await rm(target, { recursive: true })
  await writeFile(target, 'user data')
  await expect(withDshNewWorkspace(source, target, publish)).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe('user data')
  await rm(target)
  await symlink(source, target, 'junction')
  await expect(withDshNewWorkspace(source, target, publish)).rejects.toThrow()
  expect(publish).not.toHaveBeenCalled()
})

it('rolls back complete copied content when publication fails or is cancelled', async () => {
  const { parent, source, target } = await fixture()
  const failure = new Error('publisher refused')
  await expect(withDshNewWorkspace(source, target, async () => { throw failure })).rejects.toBe(failure)
  expect(await readdir(parent)).toEqual(['source'])
  const abort = new AbortController()
  await expect(withDshNewWorkspace(source, target, async () => {
    abort.abort(failure)
    abort.signal.throwIfAborted()
  }, abort.signal)).rejects.toBe(failure)
  expect(await readdir(parent)).toEqual(['source'])
})

it('cleans partial materialization without following an unsupported staged link', async () => {
  const { parent, source, target } = await fixture()
  await symlink(parent, join(source, 'z-link'), 'junction')
  const publish = vi.fn()
  await expect(withDshNewWorkspace(source, target, publish)).rejects.toThrow('unsupported objects')
  expect(await readdir(parent)).toEqual(['source'])
  expect(publish).not.toHaveBeenCalled()
})

it.each(['modified', 'truncated', 'foreign', 'replaced'] as const)('retains uncertain data when rollback sees %s content', async (change) => {
  const { source, target } = await fixture()
  await expect(withDshNewWorkspace(source, target, async (cwd) => {
    if (change === 'modified') await writeFile(join(cwd, '.binary'), 'user edit')
    else if (change === 'truncated') await writeFile(join(cwd, '.binary'), Buffer.from([0]))
    else if (change === 'foreign') await writeFile(join(cwd, 'user.txt'), 'new user data')
    else {
      await rename(cwd, `${cwd}-moved`)
      await mkdir(cwd)
      await writeFile(join(cwd, 'user.txt'), 'replacement data')
    }
    throw new Error('publisher failure')
  })).rejects.toThrow('outcome unknown')
  expect(await readFile(join(target, change === 'modified' || change === 'truncated' ? '.binary' : 'user.txt'), 'utf8'))
    .toBe(change === 'modified' ? 'user edit' : change === 'truncated' ? '\0' : change === 'foreign' ? 'new user data' : 'replacement data')
})

it('does not create a destination after cancellation or invent missing parent directories', async () => {
  const { parent, source, target } = await fixture()
  const publish = vi.fn()
  await expect(withDshNewWorkspace(source, target, publish, AbortSignal.abort())).rejects.toThrow()
  await expect(withDshNewWorkspace(source, join(target, 'nested'), publish)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(parent)).toEqual(['source'])
  expect(publish).not.toHaveBeenCalled()
})


it('admits only one concurrent creator and never rolls back the winning attempt', async () => {
  const { source, target } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const first = withDshNewWorkspace(source, target, async () => {
    entered.resolve(undefined)
    await release.promise
    return 'winner'
  })
  await entered.promise
  await expect(withDshNewWorkspace(source, target, async () => 'loser')).rejects.toMatchObject({ code: 'EEXIST' })
  release.resolve(undefined)
  expect(await first).toBe('winner')
  expect(await readFile(join(target, '.binary'))).toEqual(Buffer.from([0, 255, 17]))
})


it('closes and removes an interrupted partially written file when its bytes match the source prefix', async () => {
  const { parent, source, target } = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const failure = new Error('injected partial write failure')
  let closed = false
  vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode)
    const write = handle.writeFile.bind(handle)
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
      await write(Buffer.from([0]))
      throw failure
    })
    vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); closed = true })
    return handle
  })
  await expect(withDshNewWorkspace(source, target, vi.fn())).rejects.toBe(failure)
  expect(closed).toBe(true)
  expect(await readdir(parent)).toEqual(['source'])
})
