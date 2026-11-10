import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createDshWorkspaceBackup, DshWorkspaceBackupError, inspectDshWorkspaceBackup } from '../src/workspace-backup.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(writeFileAtomic).mockReset()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const identity = { targetSessionId: 'new-session', importId: 'import-1' }
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-backup-test-'))
  roots.push(parent)
  const source = join(parent, 'source')
  await mkdir(join(source, 'empty'), { recursive: true })
  await writeFile(join(source, '.secret'), Buffer.from([0, 255, 9]))
  return { parent, source }
}

it('creates a complete content backup and inspects it independently of later source changes', async () => {
  const { source, parent } = await fixture()
  const backup = await createDshWorkspaceBackup(source, parent, identity)
  expect(backup.record).toMatchObject({ ...identity, state: 'ready', sourcePath: source })
  expect(await readFile(join(backup.workspacePath, '.secret'))).toEqual(Buffer.from([0, 255, 9]))
  expect(await readdir(join(backup.workspacePath, 'empty'))).toEqual([])
  await writeFile(join(source, '.secret'), 'later user edit')
  expect(await inspectDshWorkspaceBackup(backup.directory)).toEqual(backup)
  expect(await readFile(join(source, '.secret'), 'utf8')).toBe('later user edit')
  await writeFile(join(backup.workspacePath, '.secret'), 'corrupt backup')
  await expect(inspectDshWorkspaceBackup(backup.directory)).rejects.toThrow('content differs')
})

it('refuses nested backup parents, child links and cancellation before writing', async () => {
  const { source, parent } = await fixture()
  await expect(createDshWorkspaceBackup(source, source, identity)).rejects.toThrow('outside')
  await expect(createDshWorkspaceBackup(source, join(source, 'empty'), identity)).rejects.toThrow('outside')
  await expect(createDshWorkspaceBackup(source, parent, identity, AbortSignal.abort())).rejects.toThrow()
  await symlink(parent, join(source, 'link'), 'junction')
  await expect(createDshWorkspaceBackup(source, parent, identity)).rejects.toThrow('symbolic links')
  expect(await readdir(parent)).toEqual(['source'])
})

it.each(['ready-write', 'source-change', 'cancel'] as const)('never accepts incomplete backup after %s', async (failure) => {
  const { source, parent } = await fixture()
  const abort = new AbortController()
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
  vi.mocked(writeFileAtomic).mockImplementation(async (path, bytes, options) => {
    if (bytes.includes('"state":"ready"') && failure === 'ready-write') throw new Error('ready write failed')
    await actual.writeFileAtomic(path, bytes, options)
    if (bytes.includes('"state":"copying"')) {
      if (failure === 'source-change') await writeFile(join(source, '.secret'), 'changed before copy')
      if (failure === 'cancel') abort.abort(new Error('cancel backup'))
    }
  })
  let retained: string | undefined
  try { await createDshWorkspaceBackup(source, parent, identity, abort.signal); expect.fail('backup must fail') }
  catch (error: unknown) {
    if (!(error instanceof DshWorkspaceBackupError)) throw error
    retained = error.directory
  }
  expect((await inspectDshWorkspaceBackup(retained)).record.state).toBe('copying')
  expect(await readFile(join(source, '.secret'))).toEqual(failure === 'source-change' ? Buffer.from('changed before copy') : Buffer.from([0, 255, 9]))
})

it('rejects malformed metadata and a replaced payload root without following it', async () => {
  const { source, parent } = await fixture()
  const backup = await createDshWorkspaceBackup(source, parent, identity)
  await rm(backup.workspacePath, { recursive: true })
  await symlink(source, backup.workspacePath, 'junction')
  await expect(inspectDshWorkspaceBackup(backup.directory)).rejects.toThrow('payload directory was replaced')
  await writeFile(join(backup.directory, 'backup.json'), '{}')
  await expect(inspectDshWorkspaceBackup(backup.directory)).rejects.toThrow('invalid manifest')
  expect(await readFile(join(source, '.secret'))).toEqual(Buffer.from([0, 255, 9]))
})
