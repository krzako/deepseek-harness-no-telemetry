import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDshWorkspaceExport } from '../src/workspace-export.ts'
import { fingerprintDshWorkspace } from '../src/workspace-fingerprint.ts'
import { createDshArchiveResourceBudget, measureDshArchiveEntry } from '../src/manifest-stream.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-workspace-export-'))
  roots.push(path)
  return path
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function consume(snapshot: Awaited<ReturnType<typeof captureDshWorkspaceExport>>): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  for (const entry of snapshot.entries()) {
    if (!('chunks' in entry)) throw new Error('expected streamed file')
    const chunks: Buffer[] = []
    for await (const chunk of entry.chunks) chunks.push(Buffer.from(chunk))
    files.set(entry.path, Buffer.concat(chunks))
  }
  await snapshot.verify()
  return files
}

describe('optional workspace export', () => {
  it('preserves binary and hidden files, empty directories and location-independent fingerprint', async () => {
    const cwd = await root()
    await mkdir(join(cwd, 'nested/empty'), { recursive: true })
    const bytes = Buffer.from([0, 255, 12, 42])
    await writeFile(join(cwd, '.secret'), bytes)
    await writeFile(join(cwd, 'nested/zero'), '')
    const snapshot = await captureDshWorkspaceExport(cwd)
    expect(snapshot.metadata.snapshot?.directories).toEqual(['workspace/nested', 'workspace/nested/empty'])
    expect(snapshot.metadata).toMatchObject(await fingerprintDshWorkspace(cwd))
    expect(await consume(snapshot)).toEqual(new Map([['workspace/.secret', bytes], ['workspace/nested/zero', Buffer.alloc(0)]]))
    expect(await readFile(join(cwd, '.secret'))).toEqual(bytes)
  })

  it('refuses missing workspaces, links and nonportable names without silently excluding them', async () => {
    await expect(captureDshWorkspaceExport(null)).rejects.toThrow('existing absolute workspace')
    await expect(captureDshWorkspaceExport('relative')).rejects.toThrow('existing absolute workspace')
    const cwd = await root()
    await expect(captureDshWorkspaceExport(join(cwd, 'missing'))).rejects.toThrow()
    await symlink(cwd, join(cwd, 'link'), 'dir')
    await expect(captureDshWorkspaceExport(cwd)).rejects.toThrow('symbolic links')
    await rm(join(cwd, 'link'))
    if (process.platform !== 'win32') {
      await writeFile(join(cwd, 'bad:name'), 'x')
      await expect(captureDshWorkspaceExport(cwd)).rejects.toThrow('unsupported archive path')
    }
  })

  it('rejects changes before reading and changes to the directory inventory before completion', async () => {
    const cwd = await root()
    await writeFile(join(cwd, 'file'), 'before')
    const snapshot = await captureDshWorkspaceExport(cwd)
    await writeFile(join(cwd, 'file'), 'after')
    await expect(consume(snapshot)).rejects.toThrow('workspace changed')
    const next = await captureDshWorkspaceExport(cwd)
    await mkdir(join(cwd, 'new-empty'))
    await expect(next.verify()).rejects.toThrow('workspace changed')
  })

  it('detects mutation during streamed reading and applies the existing byte budget', async () => {
    const cwd = await root()
    await writeFile(join(cwd, 'file'), Buffer.alloc(256 * 1024, 42))
    const snapshot = await captureDshWorkspaceExport(cwd)
    for (const entry of snapshot.entries()) {
      if (!('chunks' in entry)) throw new Error('expected chunks')
      const iterator = entry.chunks[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done) throw new Error('expected file content')
      expect(first.value.length).toBeLessThanOrEqual(64 * 1024)
      await writeFile(join(cwd, 'file'), 'changed')
      await expect((async () => { while (!(await iterator.next()).done) { /* drain to the stability barrier */ } })()).rejects.toThrow('workspace changed')
    }
    const next = await captureDshWorkspaceExport(cwd)
    for (const entry of next.entries()) {
      const measured = measureDshArchiveEntry(entry, 'workspace', createDshArchiveResourceBudget({ maxEntryBytes: 1 }))
      if (!('chunks' in measured.entry)) throw new Error('expected chunks')
      const chunks = measured.entry.chunks
      await expect((async () => { for await (const _ of chunks) { /* budget rejects */ } })()).rejects.toThrow()
    }
  })

  it('honors cancellation during capture and file consumption', async () => {
    const cwd = await root()
    const abort = new AbortController()
    abort.abort()
    await expect(captureDshWorkspaceExport(cwd, abort.signal)).rejects.toThrow()
    await writeFile(join(cwd, 'file'), Buffer.alloc(256 * 1024))
    const snapshot = await captureDshWorkspaceExport(cwd)
    const reading = new AbortController()
    await expect((async () => {
      for (const entry of snapshot.entries(reading.signal)) {
        if (!('chunks' in entry)) throw new Error('expected chunks')
        for await (const _ of entry.chunks) reading.abort()
      }
    })()).rejects.toThrow()
    await rm(join(cwd, 'file'))
  })
})
