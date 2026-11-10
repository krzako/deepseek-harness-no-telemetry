import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { previewDshWorkspaceImport } from '../src/workspace-preview.ts'
import type { DshArchiveWorkspaceV1 } from '../src/manifest.ts'
import { createHash } from 'node:crypto'
import { completeDshArchiveManifestV1 } from '../src/manifest-stream.ts'
import { compareDshWorkspaceSnapshot } from '../src/workspace-conflicts.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-workspace-preview-'))
  roots.push(path)
  return path
}

function source(snapshot: boolean): DshArchiveWorkspaceV1 {
  return { sourceCwd: '/old/project', fingerprint: 'a'.repeat(64),
    snapshot: snapshot ? { prefix: 'workspace', complete: true } : null }
}

it.each([
  [true, true, ['keep-workspace', 'apply-snapshot']],
  [true, false, ['keep-workspace']],
  [false, true, ['apply-snapshot']],
  [false, false, ['context-only']],
] as const)('offers workspace choices for existing=%s snapshot=%s without writes', async (existing, snapshot, actions) => {
  const parent = await root()
  const target = join(parent, 'project')
  if (existing) {
    await mkdir(target)
    await writeFile(join(target, 'user.txt'), 'keep exact contents')
  }
  const before = await readdir(parent)
  const result = await previewDshWorkspaceImport(source(snapshot), target)
  expect(result.targetExists).toBe(existing)
  expect(result.choices.map(choice => choice.action)).toEqual(actions)
  expect(result.choices.find(choice => choice.action === 'apply-snapshot')).toEqual(snapshot ? {
    action: 'apply-snapshot', fidelity: 'unverified', separateConfirmation: existing,
    recoverableBackup: existing, needsWorkspaceBeforeTurn: false,
  } : undefined)
  expect(result.choices.find(choice => choice.action === 'context-only')?.needsWorkspaceBeforeTurn).toBe(existing || snapshot ? undefined : true)
  expect(result.warnings).toContain(existing ? 'workspace-unverified' : 'workspace-missing')
  expect(await readdir(parent)).toEqual(before)
  if (existing) expect(await readFile(join(target, 'user.txt'), 'utf8')).toBe('keep exact contents')
})

it('does not infer matching contents from an existing path and source digest', async () => {
  const target = await root()
  const preview = await previewDshWorkspaceImport(source(false), target)
  expect(preview.sourceFingerprint).toBe('a'.repeat(64))
  expect(preview.choices[0]?.fidelity).toBe('unverified')
})

it('requires a destination before offering snapshot materialization', async () => {
  const result = await previewDshWorkspaceImport(source(true), null)
  expect(result.choices).toEqual([])
  expect(result.warnings).toContain('workspace-destination-required')
  expect((await previewDshWorkspaceImport(source(false), null)).choices[0]?.action).toBe('context-only')
})

it('rejects files and relative paths without creating a workspace', async () => {
  const file = join(await root(), 'file')
  await writeFile(file, 'untouched')
  await expect(previewDshWorkspaceImport(source(true), file)).rejects.toThrow('not a directory')
  await expect(previewDshWorkspaceImport(source(true), 'relative')).rejects.toThrow('fully qualified')
  expect(await readFile(file, 'utf8')).toBe('untouched')
})

it('canonicalizes an existing directory link but does not treat a dangling link as free space', async () => {
  const parent = await root()
  const directory = join(parent, 'real')
  const alias = join(parent, 'alias')
  const dangling = join(parent, 'dangling')
  await mkdir(directory)
  await symlink(directory, alias, 'junction')
  await symlink(join(parent, 'missing'), dangling, 'junction')
  expect((await previewDshWorkspaceImport(source(true), alias)).targetPath).toBe(directory)
  await expect(previewDshWorkspaceImport(source(true), dangling)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not disguise access errors as absent destinations', async () => {
  vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
  await expect(previewDshWorkspaceImport(source(true), join(tmpdir(), 'protected-project')))
    .rejects.toMatchObject({ code: 'EACCES' })
})

it('does not publish a cancelled observation', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancel workspace preview'))
  await expect(previewDshWorkspaceImport(source(false), null, controller.signal)).rejects.toThrow('cancel workspace preview')
})

function snapshot(files: Record<string, string>) {
  return completeDshArchiveManifestV1({ rootSessionId: 'root', sessionLogPath: 'session.jsonl',
    driverStatePath: 'driver.json', contextPath: 'context.json', privateSnapshotPath: null,
    workspace: source(true) }, [
    ...(['session-log', 'driver-state', 'portable-context'] as const).map((kind, index) => ({
      path: ['session.jsonl', 'driver.json', 'context.json'][index]!, kind, bytes: 0, sha256: createHash('sha256').digest('hex'),
    })),
    ...Object.entries(files).map(([path, content]) => ({ path: `workspace/${path}`, kind: 'workspace' as const,
      bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') })),
  ])
}

it('compares snapshot contents without changing files or claiming whole-workspace fidelity', async () => {
  const target = await root()
  await writeFile(join(target, 'same'), 'identical')
  await writeFile(join(target, 'changed'), 'old')
  await writeFile(join(target, 'extra'), 'not part of snapshot')
  const manifest = snapshot({ same: 'identical', changed: 'new', 'nested/new': 'added' })
  expect(await compareDshWorkspaceSnapshot(manifest, target)).toEqual([
    { path: 'same', kind: 'file', status: 'identical' }, { path: 'changed', kind: 'file', status: 'changed' }, { path: 'nested/new', kind: 'file', status: 'new' },
  ])
  expect(await readFile(join(target, 'changed'), 'utf8')).toBe('old')
  expect(await readdir(target)).toEqual(['changed', 'extra', 'same'])
  expect((await previewDshWorkspaceImport(manifest.workspace, target)).choices[0]?.fidelity).toBe('unverified')
})

it('reports directory, file-parent and link conflicts without following links', async () => {
  const target = await root()
  const outside = await root()
  await writeFile(join(outside, 'secret'), 'do not read')
  await mkdir(join(target, 'directory'))
  await writeFile(join(target, 'parent'), 'file blocks directory')
  await symlink(outside, join(target, 'link'), 'junction')
  await symlink(join(outside, 'secret'), join(target, 'file-link'))
  expect(await compareDshWorkspaceSnapshot(snapshot({ directory: 'file', 'parent/child': 'file',
    'link/secret': 'do not read', 'file-link': 'do not read' }), target)).toEqual([
    { path: 'directory', kind: 'file', status: 'type-conflict', conflictPath: 'directory' },
    { path: 'parent/child', kind: 'file', status: 'parent-conflict', conflictPath: 'parent' },
    { path: 'link/secret', kind: 'file', status: 'parent-conflict', conflictPath: 'link' },
    { path: 'file-link', kind: 'file', status: 'type-conflict', conflictPath: 'file-link' },
  ])
  expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('do not read')
})

it('distinguishes absent snapshots, empty snapshots and new files at an absent destination', async () => {
  const manifest = snapshot({ 'new.txt': 'new' })
  expect(await compareDshWorkspaceSnapshot(manifest, null)).toEqual([{ path: 'new.txt', kind: 'file', status: 'new' }])
  expect(await compareDshWorkspaceSnapshot(snapshot({}), null)).toEqual([])
  expect(await compareDshWorkspaceSnapshot({ ...manifest, workspace: source(false) }, null)).toBeNull()
})

it('propagates snapshot comparison access errors and cancellation', async () => {
  const target = await root()
  vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(compareDshWorkspaceSnapshot(snapshot({ file: 'x' }), target)).rejects.toMatchObject({ code: 'EACCES' })
  await expect(compareDshWorkspaceSnapshot(snapshot({ file: 'x' }), target, AbortSignal.abort(new Error('cancel comparison'))))
    .rejects.toThrow('cancel comparison')
})

it('rejects a workspace replaced by a link since directory preview', async () => {
  const parent = await root()
  const target = join(parent, 'target')
  const outside = await root()
  await mkdir(target)
  const preview = await previewDshWorkspaceImport(source(true), target)
  await rm(target, { recursive: true })
  await symlink(outside, target, 'junction')
  await expect(compareDshWorkspaceSnapshot(snapshot({ file: 'x' }), preview.targetPath)).rejects.toThrow('workspace changed')
})

it('closes the file handle when cancellation interrupts a streamed comparison', async () => {
  const target = await root()
  const content = 'x'.repeat(256 * 1024)
  await writeFile(join(target, 'file'), content)
  const controller = new AbortController()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const handle = await actual.open(join(target, 'file'), 'r')
  const close = vi.spyOn(handle, 'close')
  const stream = handle.createReadStream.bind(handle)
  vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
    const reader = stream(options)
    reader.once('data', () => { controller.abort() })
    return reader
  })
  vi.mocked(fs.open).mockResolvedValueOnce(handle)
  await expect(compareDshWorkspaceSnapshot(snapshot({ file: content }), target, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(close).toHaveBeenCalled()
  await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
})

it('distinguishes recorded directory structure from legacy file-only snapshots', async () => {
  const workspace = source(true)
  const target = join(await root(), 'missing')
  const legacy = await previewDshWorkspaceImport(workspace, target)
  expect(legacy.warnings).toContain('snapshot-directories-unrecorded')
  expect(legacy.choices[0]?.fidelity).toBe('unverified')
  const complete = await previewDshWorkspaceImport({ ...workspace,
    snapshot: { prefix: 'workspace', complete: true, directories: [] } }, target)
  expect(complete.warnings).not.toContain('snapshot-directories-unrecorded')
  expect(complete.choices[0]?.fidelity).toBe('snapshot-content')
})


it('reports empty directory conflicts and presence without claiming matching contents', async () => {
  const target = await root()
  const outside = await root()
  await mkdir(join(target, 'present'))
  await writeFile(join(target, 'present/extra'), 'not represented in snapshot')
  await writeFile(join(target, 'blocked'), 'keep user file')
  await symlink(outside, join(target, 'link'), 'junction')
  const manifest = snapshot({})
  const directories = ['present', 'blocked', 'blocked/child', 'link', 'link/child', 'new']
  const withDirectories = { ...manifest, workspace: { ...manifest.workspace,
    snapshot: { prefix: 'workspace', complete: true, directories: directories.map(path => `workspace/${path}`) } } }
  expect(await compareDshWorkspaceSnapshot(withDirectories, target)).toEqual([
    { path: 'present', kind: 'directory', status: 'directory-present' },
    { path: 'blocked', kind: 'directory', status: 'type-conflict', conflictPath: 'blocked' },
    { path: 'blocked/child', kind: 'directory', status: 'parent-conflict', conflictPath: 'blocked' },
    { path: 'link', kind: 'directory', status: 'type-conflict', conflictPath: 'link' },
    { path: 'link/child', kind: 'directory', status: 'parent-conflict', conflictPath: 'link' },
    { path: 'new', kind: 'directory', status: 'new' },
  ])
  expect(await compareDshWorkspaceSnapshot(withDirectories, null)).toEqual(
    directories.map(path => ({ path, kind: 'directory', status: 'new' })))
  expect(await readFile(join(target, 'blocked'), 'utf8')).toBe('keep user file')
  expect(await readdir(outside)).toEqual([])
})
