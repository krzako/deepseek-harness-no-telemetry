import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DshWorkspaceMoveDurabilityError, moveWorkspacePathExclusive } from '../src/workspace-move.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(open).mockReset()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exclusive-move-'))
  roots.push(root)
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'data'), 'source bytes')
  return { root, source, destination }
}

it.skipIf(process.platform !== 'linux')('moves a real nonempty directory and refuses an existing target atomically', async () => {
  const { root, source, destination } = await fixture()
  await moveWorkspacePathExclusive(source, destination)
  expect(await readFile(join(destination, 'data'), 'utf8')).toBe('source bytes')
  expect(await readdir(root)).toEqual(['destination'])
  await mkdir(source)
  await writeFile(join(source, 'other'), 'new source')
  await expect(moveWorkspacePathExclusive(source, destination)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(destination, 'data'), 'utf8')).toBe('source bytes')
  expect(await readFile(join(source, 'other'), 'utf8')).toBe('new source')
})

it.skipIf(process.platform !== 'linux').each(['empty', 'file', 'link'])('never replaces a preexisting %s destination', async (kind) => {
  const { source, destination } = await fixture()
  if (kind === 'empty') await mkdir(destination)
  else if (kind === 'file') await writeFile(destination, 'user data')
  else await symlink(source, destination, 'junction')
  await expect(moveWorkspacePathExclusive(source, destination)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(source, 'data'), 'utf8')).toBe('source bytes')
  if (kind === 'file') expect(await readFile(destination, 'utf8')).toBe('user data')
})

it.skipIf(process.platform !== 'linux')('reports an already completed move when the directory flush fails', async () => {
  const { root, source, destination } = await fixture()
  vi.mocked(open).mockRejectedValueOnce(new Error('flush unavailable'))
  await expect(moveWorkspacePathExclusive(source, destination)).rejects.toBeInstanceOf(DshWorkspaceMoveDurabilityError)
  expect(await readdir(root)).toEqual(['destination'])
  expect(await readFile(join(destination, 'data'), 'utf8')).toBe('source bytes')
})

it('refuses relative, identical and NUL-containing paths before native invocation', async () => {
  await expect(moveWorkspacePathExclusive('relative', '/target')).rejects.toThrow('absolute paths')
  await expect(moveWorkspacePathExclusive('/source\0suffix', '/target')).rejects.toThrow('without NUL')
  await expect(moveWorkspacePathExclusive('/source', '/source')).rejects.toThrow('distinct')
})
