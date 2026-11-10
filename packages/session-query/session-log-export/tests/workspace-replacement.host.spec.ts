import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDshWorkspaceBackup } from '../src/workspace-backup.ts'
import { withDshWorkspaceReplacement } from '../src/workspace-replacement.ts'
import { DshWorkspaceMoveDurabilityError, moveWorkspacePathExclusive } from '../src/workspace-move.ts'

vi.mock('../src/workspace-move.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workspace-move.ts')>()
  return { ...actual, moveWorkspacePathExclusive: vi.fn(actual.moveWorkspacePathExclusive) }
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(moveWorkspacePathExclusive).mockReset()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-replacement-'))
  roots.push(parent)
  const source = join(parent, 'project')
  const snapshot = join(parent, 'snapshot')
  await mkdir(source)
  await mkdir(snapshot)
  await writeFile(join(source, 'original'), 'original bytes')
  await chmod(join(source, 'original'), 0o700)
  await writeFile(join(snapshot, 'replacement'), 'snapshot bytes')
  const backup = await createDshWorkspaceBackup(source, parent, { targetSessionId: 'target', importId: 'import' })
  return { source, snapshot, backup }
}

it('replaces the whole tree and retains the original inode metadata and content copy', async () => {
  const { source, snapshot, backup } = await fixture()
  const before = await stat(join(source, 'original'))
  expect(await withDshWorkspaceReplacement(snapshot, backup, async () => 'published')).toBe('published')
  expect(await readdir(source)).toEqual(['replacement'])
  expect(await readFile(join(backup.directory, 'original', 'original'), 'utf8')).toBe('original bytes')
  expect(await stat(join(backup.directory, 'original', 'original'))).toMatchObject({ ino: before.ino, mode: before.mode })
  expect(await readFile(join(backup.workspacePath, 'original'), 'utf8')).toBe('original bytes')
})

it.each(['failure', 'cancel'])('restores the original workspace on publication %s', async (kind) => {
  const { source, snapshot, backup } = await fixture()
  const abort = new AbortController()
  await expect(withDshWorkspaceReplacement(snapshot, backup, async () => {
    if (kind === 'cancel') { abort.abort(); abort.signal.throwIfAborted() }
    throw new Error('publisher failed')
  }, abort.signal)).rejects.toThrow()
  expect(await readdir(source)).toEqual(['original'])
  expect(await readFile(join(source, 'original'), 'utf8')).toBe('original bytes')
  expect(await readdir(backup.directory)).toEqual(['backup.json', 'workspace'])
})

it('preserves edits made to the installed snapshot when publication fails', async () => {
  const { source, snapshot, backup } = await fixture()
  await expect(withDshWorkspaceReplacement(snapshot, backup, async () => {
    await writeFile(join(source, 'replacement'), 'user edit')
    throw new Error('publisher failed')
  })).rejects.toThrow('outcome unknown')
  expect(await readFile(join(source, 'replacement'), 'utf8')).toBe('user edit')
  expect(await readFile(join(backup.directory, 'original', 'original'), 'utf8')).toBe('original bytes')
})

it.each(['before', 'during'])('preserves source changes %s displacement and refuses publication', async (when) => {
  const { source, snapshot, backup } = await fixture()
  const actual = await vi.importActual<typeof import('../src/workspace-move.ts')>('../src/workspace-move.ts')
  if (when === 'before') await writeFile(join(source, 'original'), 'user edit')
  else vi.mocked(moveWorkspacePathExclusive).mockImplementationOnce(async (from, to) => {
    await writeFile(join(source, 'original'), 'user edit')
    await actual.moveWorkspacePathExclusive(from, to)
  })
  const publish = vi.fn()
  await expect(withDshWorkspaceReplacement(snapshot, backup, publish)).rejects.toThrow('source changed')
  expect(publish).not.toHaveBeenCalled()
  expect(await readFile(join(source, 'original'), 'utf8')).toBe('user edit')
})

it('never overwrites a competing directory created after displacement', async () => {
  const { source, snapshot, backup } = await fixture()
  const actual = await vi.importActual<typeof import('../src/workspace-move.ts')>('../src/workspace-move.ts')
  vi.mocked(moveWorkspacePathExclusive).mockImplementationOnce(async (from, to) => {
    await actual.moveWorkspacePathExclusive(from, to)
    await mkdir(source)
    await writeFile(join(source, 'foreign'), 'keep user data')
  })
  await expect(withDshWorkspaceReplacement(snapshot, backup, vi.fn())).rejects.toThrow('outcome unknown')
  expect(await readFile(join(source, 'foreign'), 'utf8')).toBe('keep user data')
  expect(await readFile(join(backup.directory, 'original', 'original'), 'utf8')).toBe('original bytes')
})

it.each([1, 2])('restores after post-move durability failure at move %s', async (failureAt) => {
  const { source, snapshot, backup } = await fixture()
  const actual = await vi.importActual<typeof import('../src/workspace-move.ts')>('../src/workspace-move.ts')
  let calls = 0
  vi.mocked(moveWorkspacePathExclusive).mockImplementation(async (from, to) => {
    await actual.moveWorkspacePathExclusive(from, to)
    if (++calls === failureAt) throw new DshWorkspaceMoveDurabilityError(to, new Error('flush failed'))
  })
  await expect(withDshWorkspaceReplacement(snapshot, backup, vi.fn())).rejects.toThrow('flush failed')
  expect(await readFile(join(source, 'original'), 'utf8')).toBe('original bytes')
})
