import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fingerprintDshWorkspace } from '../src/workspace-fingerprint.ts'
import { previewDshWorkspaceImport } from '../src/workspace-preview.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-fingerprint-'))
  roots.push(path)
  return path
}

it('hashes ordered content records independently of root location, creation order and permissions', async () => {
  const first = await root()
  const second = await root()
  await writeFile(join(first, 'z.txt'), 'pełna treść')
  await mkdir(join(first, 'empty'))
  await mkdir(join(second, 'empty'))
  await writeFile(join(second, 'z.txt'), 'pełna treść')
  await chmod(join(second, 'z.txt'), 0o600)
  const records = 'dsh-workspace-content-v1\n["directory",""]\n["directory","empty"]\n'
    + JSON.stringify(['file', 'z.txt', Buffer.byteLength('pełna treść'), createHash('sha256').update('pełna treść').digest('hex')]) + '\n'
  const expected = { fingerprint: createHash('sha256').update(records).digest('hex'), fingerprintAlgorithm: 'dsh-workspace-content-v1' }
  expect(await fingerprintDshWorkspace(first)).toEqual(expected)
  expect(await fingerprintDshWorkspace(second)).toEqual(expected)
})

it('detects content, path and empty-directory changes and compares a relocated workspace', async () => {
  const path = await root()
  await writeFile(join(path, 'file'), 'one')
  const original = await fingerprintDshWorkspace(path)
  const workspace = { sourceCwd: '/old/location', ...original, snapshot: null }
  expect((await previewDshWorkspaceImport(workspace, path)).fingerprintComparison).toBe('matching-content')
  expect((await previewDshWorkspaceImport({ sourceCwd: '/old', fingerprint: original.fingerprint, snapshot: null }, path))
    .fingerprintComparison).toBe('unverified')
  await writeFile(join(path, 'file'), 'two')
  expect((await previewDshWorkspaceImport(workspace, path)).fingerprintComparison).toBe('different-content')
  const changed = await fingerprintDshWorkspace(path)
  await mkdir(join(path, 'empty'))
  expect(await fingerprintDshWorkspace(path)).not.toEqual(changed)
  const directory = await fingerprintDshWorkspace(path)
  await writeFile(join(path, 'extra'), '')
  expect(await fingerprintDshWorkspace(path)).not.toEqual(directory)
})

it('fingerprints link text without reading its target, including dangling links', async () => {
  const path = await root()
  const outside = await root()
  const target = join(outside, 'secret')
  await writeFile(target, 'before')
  await symlink(target, join(path, 'link'))
  await symlink('missing', join(path, 'dangling'))
  const before = await fingerprintDshWorkspace(path)
  await writeFile(target, 'after')
  expect(await fingerprintDshWorkspace(path)).toEqual(before)
  await rm(join(path, 'dangling'))
  await symlink('different-missing', join(path, 'dangling'))
  expect(await fingerprintDshWorkspace(path)).not.toEqual(before)
})

it('reports absent, non-directory and unreadable roots without partial digests', async () => {
  const path = await root()
  expect(await fingerprintDshWorkspace(null)).toEqual({ fingerprint: null, fingerprintUnavailable: 'not-selected' })
  expect(await fingerprintDshWorkspace('relative')).toEqual({ fingerprint: null, fingerprintUnavailable: 'invalid-path' })
  expect(await fingerprintDshWorkspace(join(path, 'absent'))).toEqual({ fingerprint: null, fingerprintUnavailable: 'missing' })
  await writeFile(join(path, 'file'), 'contents')
  expect(await fingerprintDshWorkspace(join(path, 'file'))).toEqual({ fingerprint: null, fingerprintUnavailable: 'not-directory' })
  vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
  expect(await fingerprintDshWorkspace(path)).toEqual({ fingerprint: null, fingerprintUnavailable: 'unreadable' })
})

it('rejects mutation discovered by the final scan and cancellation', async () => {
  const path = await root()
  const file = join(path, 'file')
  await writeFile(file, 'contents')
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let reads = 0
  vi.mocked(lstat).mockImplementation(async (...args) => {
    const result = await actual.lstat(...args)
    if (args[0] === file && ++reads === 3 && 'ctimeNs' in result) result.ctimeNs += 1n
    return result
  })
  await expect(fingerprintDshWorkspace(path)).rejects.toThrow('workspace changed')
  await expect(fingerprintDshWorkspace(path, AbortSignal.abort(new Error('cancel fingerprint')))).rejects.toThrow('cancel fingerprint')
})
