/** Inspect a backup after the writer exits and the original source is unavailable. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { inspectDshWorkspaceBackup, type DshWorkspaceBackup } from '../src/workspace-backup.ts'

it('verifies the backup from a fresh process without depending on the original workspace', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-backup-restart-'))
  const source = join(parent, 'source')
  try {
    await mkdir(join(source, 'empty'), { recursive: true })
    await writeFile(join(source, 'project.txt'), 'recoverable bytes')
    const fixture = fileURLToPath(new URL('./fixtures/workspace-backup-writer.mjs', import.meta.url))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx/esm', fixture, source, parent], { env, timeout: 20_000, killSignal: 'SIGKILL' })
    const written = JSON.parse(stdout) as DshWorkspaceBackup
    await rm(source, { recursive: true })
    const inspected = await inspectDshWorkspaceBackup(written.directory)
    expect(inspected).toEqual(written)
    expect(inspected.record).toMatchObject({ state: 'ready', targetSessionId: 'new-session', importId: 'restart-import' })
    expect(await readFile(join(inspected.workspacePath, 'project.txt'), 'utf8')).toBe('recoverable bytes')
  } finally { await rm(parent, { recursive: true, force: true }) }
})
