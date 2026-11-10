import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { createDshWorkspaceImportJournal, inspectDshWorkspaceImport, retainDshWorkspaceImport } from '../src/workspace-recovery.ts'
import { fingerprintDshWorkspace } from '../src/workspace-fingerprint.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-workspace-recovery-'))
  roots.push(parent)
  const target = join(parent, 'project')
  const journal = await createDshWorkspaceImportJournal({ targetSessionId: 'new-session', sourceSessionId: 'source',
    sourceDriverId: 'standard', importId: 'import-1', targetPath: target, expectedFingerprint: 'a'.repeat(64) })
  const persistence = { stat: vi.fn<SessionPersistence['stat']>(async () => undefined) }
  return { parent, target, journal, persistence }
}

it('persists intent before target creation and retains unknown outcomes without writes', async () => {
  const { parent, target, journal, persistence } = await fixture()
  expect(await readdir(parent)).toEqual([journal.path.split('/').at(-1)])
  const before = await readFile(journal.path)
  const report = await inspectDshWorkspaceImport(journal.path, persistence)
  expect(report).toMatchObject({ outcome: 'outcome-unknown', sessionState: 'not-published',
    record: { phase: 'intent', targetPath: target, targetSessionId: 'new-session' }, workspace: { exists: false } })
  expect(await retainDshWorkspaceImport(report, persistence)).toBe('outcome-unknown')
  expect(await readFile(journal.path)).toEqual(before)
})

it('recognizes durable Session publication without needing a post-commit journal mutation', async () => {
  const { target, journal, persistence } = await fixture()
  await mkdir(target)
  await writeFile(join(target, 'data'), 'workspace')
  await journal.record('materialized')
  persistence.stat.mockResolvedValue({ header: { id: 'new-session', cwd: target,
    importLineage: { sourceSessionId: 'source', sourceDriverId: 'standard', importId: 'import-1' } } } as Awaited<ReturnType<SessionPersistence['stat']>>)
  expect(await inspectDshWorkspaceImport(journal.path, persistence)).toMatchObject({ outcome: 'published',
    record: { phase: 'materialized' }, workspace: { exists: true, identityMatches: true,
      fingerprint: (await fingerprintDshWorkspace(target)).fingerprint } })
  persistence.stat.mockResolvedValue({ header: { id: 'new-session', cwd: target,
    importLineage: { sourceSessionId: 'source', sourceDriverId: 'standard', importId: 'different-import' } } } as Awaited<ReturnType<SessionPersistence['stat']>>)
  expect(await inspectDshWorkspaceImport(journal.path, persistence)).toMatchObject({ outcome: 'outcome-unknown', sessionState: 'mismatched' })
  persistence.stat.mockResolvedValue({ header: { id: 'new-session', cwd: target } } as Awaited<ReturnType<SessionPersistence['stat']>>)
  expect(await inspectDshWorkspaceImport(journal.path, persistence)).toMatchObject({ outcome: 'outcome-unknown', sessionState: 'mismatched' })
})

it('reports a recorded rollback but never deletes remaining or subsequently edited data', async () => {
  const { target, journal, persistence } = await fixture()
  await journal.record('rolled-back')
  expect((await inspectDshWorkspaceImport(journal.path, persistence)).outcome).toBe('rolled-back')
  await mkdir(target)
  await writeFile(join(target, 'user.txt'), 'keep user edit')
  const report = await inspectDshWorkspaceImport(journal.path, persistence)
  expect(report.outcome).toBe('outcome-unknown')
  await writeFile(join(target, 'user.txt'), 'new edit')
  await expect(retainDshWorkspaceImport(report, persistence)).rejects.toThrow('observation changed')
  const changed = await inspectDshWorkspaceImport(journal.path, persistence)
  expect(await retainDshWorkspaceImport(changed, persistence)).toBe('outcome-unknown')
  expect(await readFile(join(target, 'user.txt'), 'utf8')).toBe('new edit')
})

it('refuses reused intent identities, malformed journals, access errors and cancellation', async () => {
  const { target, journal, persistence } = await fixture()
  await expect(createDshWorkspaceImportJournal({ targetSessionId: 'new-session', sourceSessionId: 'source',
    sourceDriverId: 'standard', importId: 'import-1', targetPath: target, expectedFingerprint: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'EEXIST' })
  await expect(inspectDshWorkspaceImport(journal.path, persistence, AbortSignal.abort())).rejects.toThrow()
  persistence.stat.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(inspectDshWorkspaceImport(journal.path, persistence)).rejects.toMatchObject({ code: 'EACCES' })
  await writeFile(journal.path, '{}')
  await expect(inspectDshWorkspaceImport(journal.path, persistence)).rejects.toThrow('invalid recovery journal')
})
