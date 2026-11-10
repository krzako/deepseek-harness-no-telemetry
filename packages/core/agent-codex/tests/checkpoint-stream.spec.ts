import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupOrphanedCodexCheckpoints, codexCheckpointTempPrefix } from '../src/checkpoint-stream.ts'

const oldToken = codexCheckpointTempPrefix().includes('-0000000000000000-')
  ? '1111111111111111' : '0000000000000000'

describe('Codex checkpoint temporary files', () => {
  it('cleans a crashed owner after restart without touching live or unrecognized directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-cleanup-test-'))
    try {
      const stalePid = process.pid + 100_001
      const livePid = process.pid + 100_002
      const stale = await mkdtemp(join(root, `dsh-checkpoint-${stalePid}-${oldToken}-`))
      const live = await mkdtemp(join(root, `dsh-checkpoint-${livePid}-${oldToken}-`))
      const current = await mkdtemp(join(root, codexCheckpointTempPrefix()))
      const reusedPid = await mkdtemp(join(root, `dsh-checkpoint-${process.pid}-${oldToken}-`))
      const unrelated = await mkdtemp(join(root, 'other-checkpoint-'))
      await writeFile(join(stale, 'snapshot.json'), 'SECRET_PROMPT', { mode: 0o600 })
      await writeFile(join(live, 'snapshot.json'), 'ACTIVE_PROMPT', { mode: 0o600 })
      await writeFile(join(current, 'snapshot.json'), 'CURRENT_PROMPT', { mode: 0o600 })
      await writeFile(join(reusedPid, 'snapshot.json'), 'PREVIOUS_PID_PROMPT', { mode: 0o600 })
      await writeFile(join(unrelated, 'snapshot.json'), 'OTHER_PROMPT', { mode: 0o600 })
      expect(await cleanupOrphanedCodexCheckpoints(root, pid => pid === livePid)).toBe(2)
      const names = await readdir(root)
      expect(names).not.toContain(stale.slice(root.length + 1))
      expect(names).toContain(live.slice(root.length + 1))
      expect(names).toContain(current.slice(root.length + 1))
      expect(names).not.toContain(reusedPid.slice(root.length + 1))
      expect(names).toContain(unrelated.slice(root.length + 1))
      expect(await cleanupOrphanedCodexCheckpoints(root, pid => pid === livePid)).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves unexpected content untouched rather than recursively deleting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-cleanup-test-'))
    try {
      const stale = await mkdtemp(join(root, `dsh-checkpoint-${process.pid + 100_003}-${oldToken}-`))
      await writeFile(join(stale, 'do-not-delete.txt'), 'user data')
      expect(await cleanupOrphanedCodexCheckpoints(root, () => false)).toBe(0)
      expect(await readdir(stale)).toEqual(['do-not-delete.txt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tolerates another restart sweep removing the same orphan concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-cleanup-test-'))
    try {
      const stale = await mkdtemp(join(root, `dsh-checkpoint-${process.pid + 100_004}-${oldToken}-`))
      await writeFile(join(stale, 'snapshot.json'), 'SECRET_PROMPT', { mode: 0o600 })
      const counts = await Promise.all([
        cleanupOrphanedCodexCheckpoints(root, () => false),
        cleanupOrphanedCodexCheckpoints(root, () => false),
      ])
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1)
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
