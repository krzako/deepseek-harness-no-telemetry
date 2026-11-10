import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { readDshSessionArchiveLogs } from '../src/archive-logs.ts'
import { completeDshArchiveManifestV1 } from '../src/manifest-stream.ts'
import type { DshSessionArchiveManifestV1 } from '../src/manifest.ts'
import { validateDshSessionZip } from '../src/zip-validation.ts'

function log(id = 'root', parentSession?: string, delegationDepth = 0): string {
  return `${JSON.stringify({ type: 'session', version: 3, id, createdAt: 1, isSeeded: false,
    delegationDepth, cwd: '/project', ...(parentSession === undefined ? {} : { parentSession }) })}\n`
}

async function withArchive(
  logs: Record<string, string | Uint8Array>,
  check: (path: string, manifest: DshSessionArchiveManifestV1) => Promise<void>,
): Promise<void> {
  const files = Object.fromEntries(Object.entries(logs).map(([path, value]) => [path,
    typeof value === 'string' ? Buffer.from(value) : value]))
  files['driver.json'] = Buffer.from('{}')
  files['context.json'] = Buffer.from('{}')
  const manifest = completeDshArchiveManifestV1({ rootSessionId: 'root', sessionLogPath: 'root.jsonl',
    driverStatePath: 'driver.json', contextPath: 'context.json', privateSnapshotPath: null,
    workspace: { sourceCwd: '/project', fingerprint: null, snapshot: null } },
  Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    kind: path === 'driver.json' ? 'driver-state' : path === 'context.json' ? 'portable-context' : 'session-log' })))
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-logs-'))
  try {
    const path = join(directory, 'private.zip')
    await writeFile(path, zipSync({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest)) }), { mode: 0o600 })
    expect(await validateDshSessionZip(path)).toEqual(manifest)
    await check(path, manifest)
    expect(await readdir(directory)).toEqual(['private.zip'])
  } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('archive Session-log preview', () => {
  it('decodes a subtree whose root may itself have an external parent', async () => {
    await withArchive({ 'grandchild.jsonl': log('grandchild', 'child', 5),
      'root.jsonl': log('root', 'outside', 3), 'child.jsonl': log('child', 'root', 4) }, async (path, manifest) => {
      const preview = await readDshSessionArchiveLogs(path, manifest, sessionFormatCatalog)
      expect(preview.root.artifact.header).toMatchObject({ id: 'root', parentSession: 'outside' })
      expect(preview.logs.map(entry => entry.artifact.header.id)).toEqual(['grandchild', 'root', 'child'])
      expect(preview.logs.every(entry => entry.storedVersion === entry.artifact.header.version)).toBe(true)
    })
  })

  it('reports an in-memory migration without rewriting the stored archive', async () => {
    const historical = `${JSON.stringify({ type: 'session', version: 1, id: 'root', createdAt: 1,
      seedLength: 0, delegationDepth: 0, cwd: '/project' })}\n`
    await withArchive({ 'root.jsonl': historical }, async (path, manifest) => {
      const preview = await readDshSessionArchiveLogs(path, manifest, sessionFormatCatalog)
      expect(preview.root.storedVersion).toBe(1)
      expect(preview.root.artifact.header.version).toBe(sessionFormatCatalog.currentVersion)
      expect(await validateDshSessionZip(path)).toEqual(manifest)
    })
  })

  it.each([
    ['root identity', { 'root.jsonl': log('other') }, /identity differs/],
    ['duplicate identities', { 'root.jsonl': log(), 'copy.jsonl': log() }, /duplicate Session/],
    ['foreign log', { 'root.jsonl': log(), 'child.jsonl': log('foreign') }, /ancestry/],
    ['missing parent', { 'root.jsonl': log(), 'child.jsonl': log('child', 'missing', 1) }, /ancestry/],
    ['wrong depth', { 'root.jsonl': log(), 'child.jsonl': log('child', 'root', 3) }, /ancestry/],
    ['self parent', { 'root.jsonl': log(), 'child.jsonl': log('child', 'child', 1) }, /ancestry/],
    ['cycle', { 'root.jsonl': log(), 'a.jsonl': log('a', 'b', 2), 'b.jsonl': log('b', 'a', 1) }, /ancestry/],
    ['root parent inside ZIP', { 'root.jsonl': log('root', 'child', 2), 'child.jsonl': log('child', 'root', 3) }, /parent inside/],
    ['workspace disagreement', { 'root.jsonl': log().replace('/project', '/elsewhere') }, /workspace differs/],
  ] as const)('rejects %s even with matching ZIP hashes', async (_name, logs, error) => {
    await withArchive(logs, async (path, manifest) => {
      await expect(readDshSessionArchiveLogs(path, manifest, sessionFormatCatalog)).rejects.toThrow(error)
    })
  })

  it.each([
    ['unterminated log', log().slice(0, -1)],
    ['invalid JSON', `${log()}{\n`],
    ['blank row', `${log()}\n`],
    ['future format', log().replace('"version":3', '"version":999')],
    ['sequence gap', `${log()}${JSON.stringify({ type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } })}\n`],
    ['unknown required event', `${log()}${JSON.stringify({ type: 'unknown/event', seq: 0, time: 2, data: {} })}\n`],
    ['invalid UTF-8', Buffer.concat([Buffer.from(log()), Buffer.from([0xff, 0x0a])])],
  ] as const)('rejects %s without crash-tail recovery', async (_name, content) => {
    await withArchive({ 'root.jsonl': content }, async (path, manifest) => {
      await expect(readDshSessionArchiveLogs(path, manifest, sessionFormatCatalog))
        .rejects.toThrow('invalid complete Session log at root.jsonl')
    })
  })

  it('retains declared ignorable events and their unredacted values', async () => {
    const event = { type: 'external/event', seq: 0, time: 2, ignorable: true, data: 'secret: pełna treść' }
    await withArchive({ 'root.jsonl': `${log()}${JSON.stringify(event)}\n` }, async (path, manifest) => {
      const preview = await readDshSessionArchiveLogs(path, manifest, sessionFormatCatalog)
      expect(preview.root.artifact.events).toEqual([event])
    })
  })

  it('enforces limits and cancellation before returning preview', async () => {
    await withArchive({ 'root.jsonl': log() }, async (path, manifest) => {
      await expect(readDshSessionArchiveLogs(path, manifest, sessionFormatCatalog, { maxEntries: 1 })).rejects.toThrow()
      const controller = new AbortController()
      controller.abort(new Error('cancel preview'))
      await expect(readDshSessionArchiveLogs(path, manifest, sessionFormatCatalog, {}, controller.signal))
        .rejects.toThrow('cancel preview')
    })
  })
})
