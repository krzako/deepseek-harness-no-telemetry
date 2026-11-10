import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import JsonlSessionPersistence from '../src/index.ts'
import { createImportFence, IMPORT_PENDING } from '../src/import-transaction.ts'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { sessionDir, logPath } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

async function fixture(run: (store: JsonlSessionPersistence, root: string, peer: JsonlSessionPersistence) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-transaction-'))
  const ctx = new Context()
  const peerCtx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await peerCtx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await run(ctx.sessionPersistence as JsonlSessionPersistence, root, peerCtx.sessionPersistence as JsonlSessionPersistence)
  } finally {
    await ctx.fiber.dispose()
    await peerCtx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const header = { ...meta('imported'), importLineage: { sourceSessionId: meta('source').id, sourceDriverId: 'standard', importId: 'import-id' } }

describe('durable hidden JSONL import', () => {
  it('keeps flushed bytes hidden from every normal reader until publication', async () => {
    await fixture(async (store, root, peer) => {
      const transaction = await store.beginImport(header)
      await transaction.handle.append(oneTurnLog())
      await transaction.handle.flush()
      expect(await readFile(logPath(root, header.cwd, header.id, 'none'), 'utf8')).toContain('import-id')
      expect(await transaction.handle.read()).toEqual(oneTurnLog())
      for (const reader of [store, peer]) {
        expect(await reader.stat(header.id)).toBeUndefined()
        expect(await reader.list()).toEqual([])
        await expect(reader.open(header.id, 'read')).rejects.toThrow()
        await expect(reader.open(header.id, 'write')).rejects.toThrow()
        await expect(reader.create(header)).rejects.toThrow()
        await expect(reader.beginImport(header)).rejects.toThrow()
      }
      expect(await transaction.publish(() => 'registered')).toBe('registered')
      await expect(transaction.publish(() => 'duplicate')).rejects.toThrow('already settled')
      expect((await peer.stat(header.id))?.header.importLineage).toEqual(header.importLineage)
      await expect(transaction.rollback()).rejects.toThrow('published import')
      await transaction.handle.close()
      const reader = await peer.open(header.id, 'read')
      try { expect(await reader.read()).toEqual(oneTurnLog()) } finally { await reader.close() }
    })
  })

  it('removes an uncommitted durable log and permits the same fresh id again', async () => {
    await fixture(async (store, root, peer) => {
      const transaction = await store.beginImport(header)
      await transaction.handle.append(oneTurnLog())
      await transaction.rollback()
      await transaction.rollback()
      expect(await peer.list()).toEqual([])
      expect(await readdir(sessionDir(root, header.cwd, header.id))).toEqual(process.platform === 'win32' ? [] : ['session.lock'])
      const replacement = await store.beginImport(header)
      await replacement.rollback()
    })
  })

  it('restores the visibility fence when the registry callback throws', async () => {
    await fixture(async (store, _root, peer) => {
      const transaction = await store.beginImport(header)
      await transaction.handle.append(oneTurnLog())
      await expect(transaction.publish(() => { throw new Error('registry failed') })).rejects.toThrow('registry failed')
      expect(await peer.stat(header.id)).toBeUndefined()
      await transaction.rollback()
      expect(await peer.list()).toEqual([])
    })
  })

  it('never promotes an abandoned import after the owning handle closes', async () => {
    await fixture(async (store, _root, peer) => {
      const transaction = await store.beginImport(header)
      await transaction.handle.append(oneTurnLog())
      await transaction.handle.close()
      expect(await peer.list()).toEqual([])
      await expect(peer.open(header.id, 'write')).rejects.toThrow()
      await expect(peer.beginImport(header)).rejects.toThrow()
      await transaction.rollback()
    })
  })

  it('reports close failures even when subsequent rollback cleanup succeeds', async () => {
    await fixture(async (store, _root, peer) => {
      const transaction = await store.beginImport(header)
      await transaction.handle.append(oneTurnLog())
      const close = transaction.handle.close.bind(transaction.handle)
      vi.spyOn(transaction.handle, 'close').mockImplementation(async () => { await close(); throw new Error('close failure probe') })
      await expect(transaction.rollback()).rejects.toThrow('rollback could not completely clean up')
      expect(await peer.list()).toEqual([])
    })
  })

  it.skipIf(process.platform === 'win32')('cleans a failed marker publication before returning a transaction', async () => {
    await fixture(async (store, root, peer) => {
      vi.mocked(rename).mockRejectedValueOnce(new Error('marker publication failed'))
      await expect(store.beginImport(header)).rejects.toThrow('marker publication failed')
      expect(await readdir(sessionDir(root, header.cwd, header.id))).toEqual(['session.lock'])
      expect(await peer.list()).toEqual([])
      const retry = await store.beginImport(header)
      await retry.rollback()
    })
  })

  it.skipIf(process.platform === 'win32')('keeps the import hidden when durable publication fails', async () => {
    await fixture(async (store, _root, peer) => {
      const transaction = await store.beginImport(header)
      await transaction.handle.append(oneTurnLog())
      vi.mocked(rename).mockRejectedValueOnce(new Error('publication failed'))
      const publish = vi.fn()
      await expect(transaction.publish(publish)).rejects.toThrow('publication failed')
      expect(publish).not.toHaveBeenCalled()
      expect(await peer.list()).toEqual([])
      await transaction.rollback()
    })
  })

  it('reports unknown outcomes without exposing the Session and retains every byte after owner exit', async () => {
    await fixture(async (store, root, peer) => {
      const transaction = await store.beginImport(header)
      await transaction.handle.append(oneTurnLog())
      await transaction.handle.flush()
      const original = await readFile(logPath(root, header.cwd, header.id, 'none'))
      const reports = await peer.inspectPendingImports()
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({ sessionId: header.id, outcome: 'unknown', empty: false })
      await expect(peer.recoverPendingImport(reports[0]!, 'retain')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      await transaction.handle.close()
      const closed = (await peer.inspectPendingImports())[0]!
      await expect(peer.recoverPendingImport(closed, 'discard-empty')).rejects.toThrow('outcome unknown')
      expect(await peer.recoverPendingImport(closed, 'retain')).toBe('retained-outcome-unknown')
      expect(await readFile(logPath(root, header.cwd, header.id, 'none'))).toEqual(original)
      expect(await peer.list()).toEqual([])
      await expect(peer.beginImport(header)).rejects.toThrow()
      await expect(peer.open(header.id, 'read')).rejects.toThrow()
    })
  })

  it('discards only the exact empty marker, preserves the lock inode, and allows a new reservation', async () => {
    await fixture(async (store, root, peer) => {
      const directory = sessionDir(root, header.cwd, header.id)
      await mkdir(directory, { recursive: true })
      await createImportFence(directory)
      const report = (await peer.inspectPendingImports())[0]!
      expect(report.empty).toBe(true)
      expect(await peer.recoverPendingImport(report, 'discard-empty')).toBe('discarded-empty')
      expect(await peer.inspectPendingImports()).toEqual([])
      expect(await readdir(directory)).toEqual(process.platform === 'win32' ? [] : ['session.lock'])
      const transaction = await store.beginImport(header)
      await transaction.rollback()
    })
  })

  it('rejects stale reports and cancellation without removing newly written data', async () => {
    await fixture(async (_store, root, peer) => {
      const directory = sessionDir(root, header.cwd, header.id)
      await mkdir(directory, { recursive: true })
      await createImportFence(directory)
      const report = (await peer.inspectPendingImports())[0]!
      await writeFile(join(directory, 'partial-audit'), 'outcome uncertain')
      await expect(peer.recoverPendingImport(report, 'discard-empty')).rejects.toThrow('fresh report')
      const current = (await peer.inspectPendingImports())[0]!
      await expect(peer.recoverPendingImport(current, 'retain', AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
      expect(await readFile(join(directory, 'partial-audit'), 'utf8')).toBe('outcome uncertain')
      expect(await readFile(join(directory, IMPORT_PENDING), 'utf8')).toBe('DSH import pending v1\n')
    })
  })

  it('does not treat unknown marker contents as an empty reservation', async () => {
    await fixture(async (_store, root, peer) => {
      const directory = sessionDir(root, header.cwd, header.id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, IMPORT_PENDING), 'unknown data')
      const report = (await peer.inspectPendingImports())[0]!
      expect(report.empty).toBe(false)
      await expect(peer.recoverPendingImport(report, 'discard-empty')).rejects.toThrow('outcome unknown')
    })
  })

  it('refuses missing lineage and pre-aborted reservations without writing a log', async () => {
    await fixture(async (store, _root, peer) => {
      await expect(store.beginImport(meta('ordinary'))).rejects.toThrow('lineage')
      await expect(store.beginImport(header, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled')
      expect(await peer.list()).toEqual([])
    })
  })
})
