import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AtomicWriteDurabilityError, writeFileAtomic } from '../src/index.ts'

const state = vi.hoisted(() => ({ events: [] as string[], fail: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const kind = args[1] === 'wx' ? 'payload' : 'parent'
      const sync = handle.sync.bind(handle)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        state.events.push(`sync-${kind}`)
        if (state.fail === kind) throw new Error(`${kind} sync failed`)
        await sync()
      })
      vi.spyOn(handle, 'close').mockImplementation(async () => { state.events.push(`close-${kind}`); await close() })
      return handle
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      state.events.push('rename')
      if (state.fail === 'rename') throw new Error('rename failed')
      return actual.rename(...args)
    },
  }
})
vi.mock('../src/durable.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/durable.ts')>()
  return { ...actual, replaceAtomicFileWin32: async (source: string, target: string) => {
    state.events.push('write-through')
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await fs.rename(source, target)
  } }
})
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  state.events.length = 0
  state.fail = ''
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-durable-write-'))
  roots.push(root)
  const path = join(root, 'journal.json')
  await writeFile(path, 'old')
  return { root, path }
}

it.skipIf(process.platform === 'win32')('flushes bytes before replacement and parent afterwards', async () => {
  const { root, path } = await fixture()
  await writeFileAtomic(path, 'new', { mode: 0o600, durable: true })
  expect(state.events).toEqual(['sync-payload', 'close-payload', 'rename', 'sync-parent', 'close-parent'])
  expect(await readFile(path, 'utf8')).toBe('new')
  expect(await readdir(root)).toEqual(['journal.json'])
})

it.each(['payload', 'rename'])('keeps old content and cleans its temporary after %s failure', async (failure) => {
  const { root, path } = await fixture()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  state.fail = failure
  await expect(writeFileAtomic(path, 'new', { mode: 0o600, durable: true })).rejects.toThrow('failed')
  expect(await readFile(path, 'utf8')).toBe('old')
  expect(await readdir(root)).toEqual(['journal.json'])
  expect(state.events).not.toContain('sync-parent')
})

it.skipIf(process.platform === 'win32')('reports visible publication when the final parent flush fails', async () => {
  const { root, path } = await fixture()
  state.fail = 'parent'
  const attempt = writeFileAtomic(path, 'new', { mode: 0o600, durable: true })
  await expect(attempt).rejects.toBeInstanceOf(AtomicWriteDurabilityError)
  await expect(attempt).rejects.toMatchObject({ published: true, path, cause: new Error('parent sync failed') })
  expect(await readFile(path, 'utf8')).toBe('new')
  expect(await readdir(root)).toEqual(['journal.json'])
  expect(state.events.at(-1)).toBe('close-parent')
})

it('requires a pre-existing parent in durable mode and keeps ordinary writes unchanged', async () => {
  const { root } = await fixture()
  const path = join(root, 'missing/file')
  await expect(writeFileAtomic(path, 'new', { mode: 0o600, durable: true })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(root)).toEqual(['journal.json'])
  await writeFileAtomic(path, 'ordinary', { mode: 0o600 })
  expect(await readFile(path, 'utf8')).toBe('ordinary')
  expect(state.events).toEqual(['rename'])
})

it('uses the Windows write-through path after payload flush without pretending to flush a directory', async () => {
  const { path } = await fixture()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await writeFileAtomic(path, 'new', { mode: 0o600, durable: true })
  expect(state.events).toEqual(['sync-payload', 'close-payload', 'write-through'])
  expect(await readFile(path, 'utf8')).toBe('new')
})
