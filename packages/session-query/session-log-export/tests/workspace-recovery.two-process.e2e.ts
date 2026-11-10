/** SIGKILL coverage for workspace intent, materialization and durable Session publication. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { inspectDshWorkspaceImport, retainDshWorkspaceImport } from '../src/workspace-recovery.ts'

const holderPath = fileURLToPath(new URL('./fixtures/workspace-import-holder.mjs', import.meta.url))
it.each(['new', 'replacement'].flatMap(mode => ['intent', 'materialized', 'published'].map(phase => [mode, phase] as const)))
('retains %s workspace after SIGKILL at %s and inspects with a fresh backend', async (mode, phase) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-crash-'))
  const ctx = new Context()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key)))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', holderPath, root, phase, mode], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }); child.once('error', () => { resolve() }) })
  try {
    const journalPath = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { reject(new Error(`holder readiness timeout: ${stderr}`)) }, 20_000)
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        if (!stdout.includes('\n')) return
        clearTimeout(timer)
        try { resolve((JSON.parse(stdout.split('\n')[0]!) as { journalPath: string }).journalPath) } catch (error) { reject(new Error('invalid holder readiness', { cause: error })) }
      })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited ${code}: ${stderr}`)) })
    })
    expect(child.kill('SIGKILL')).toBe(true)
    await exited
    expect(child.signalCode).toBe('SIGKILL')
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    const bytes = await readFile(journalPath)
    const report = await inspectDshWorkspaceImport(journalPath, ctx.sessionPersistence)
    const expected = phase === 'published' ? 'published' : 'outcome-unknown'
    expect(report.outcome).toBe(expected)
    if (mode === 'replacement') {
      expect(report.backup?.originalFingerprint).not.toBeNull()
      expect(report.backup?.originalIdentityMatches).toBe(true)
      expect(await readFile(join(report.backup!.directory, 'original', 'original.txt'), 'utf8')).toBe('original user workspace')
      expect(await readFile(join(report.backup!.directory, 'workspace', 'original.txt'), 'utf8')).toBe('original user workspace')
    } else expect(report.backup).toBeNull()
    expect(report.record.phase).toBe(phase === 'intent' ? 'intent' : 'materialized')
    expect(report.workspace.fingerprint).toBe(report.record.expectedFingerprint)
    expect(await retainDshWorkspaceImport(report, ctx.sessionPersistence)).toBe(expected)
    const data = join(root, 'project', 'data.txt')
    expect(await readFile(data, 'utf8')).toBe('original snapshot')
    await writeFile(data, 'user edit after crash')
    await writeFile(join(root, 'project', 'foreign.txt'), 'preserve me')
    await expect(retainDshWorkspaceImport(report, ctx.sessionPersistence)).rejects.toThrow('observation changed')
    const updated = await inspectDshWorkspaceImport(journalPath, ctx.sessionPersistence)
    expect(await retainDshWorkspaceImport(updated, ctx.sessionPersistence)).toBe(expected)
    expect(await readFile(data, 'utf8')).toBe('user edit after crash')
    expect(await readFile(join(root, 'project', 'foreign.txt'), 'utf8')).toBe('preserve me')
    expect(await readFile(journalPath)).toEqual(bytes)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
