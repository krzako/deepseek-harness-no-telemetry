import { createHash } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, type SaveFileStreamAttachment, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { portableAttachmentKey } from '@deepseek-ai/dsh-agent'
import { resolveDshArchiveAttachments } from '../src/archive-attachments.ts'
import { restoreDshArchiveAttachments } from '../src/restore-attachments.ts'
import { createUserMessage, type LlmAuthenticationInfo } from '@deepseek-ai/dsh-llm'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { AgentTransferSourcePort, PortableAgentContextV1, PrivateDriverSnapshotV1 } from '@deepseek-ai/dsh-agent'
import { handleDshImportPreview } from '../src/import-preview-route.ts'
import { fingerprintDshWorkspace } from '../src/workspace-fingerprint.ts'
import { prepareDshSessionArchiveImport } from '../src/archive-import.ts'
import { previewDshSessionArchive } from '../src/archive-preview.ts'
import { verifyDshSessionArchiveProjection } from '../src/archive-projection.ts'
import { readDshSessionArchiveBundle } from '../src/archive-bundle.ts'
import { completeDshArchiveManifestV1 } from '../src/manifest-stream.ts'
import type { DshArchiveEntryV1, DshSessionArchiveManifestV1 } from '../src/manifest.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), rm: vi.fn(actual.rm) }
})

afterEach(async () => {
  vi.mocked(writeFileAtomic).mockReset()
  const mocked = vi.mocked(mkdtemp)
  const results = mocked.mock.results.filter((_, index) => String(mocked.mock.calls[index]?.[0]).includes('dsh-import-preview-'))
  mocked.mockClear()
  for (const result of results) {
    if (result.type === 'return') await expect(readdir(await result.value)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

function fixture() {
  const lineage = { sourceSessionId: 'earlier', sourceDriverId: 'standard', importId: 'earlier-import' }
  const source = { version: 1 as const, sessionId: 'root', driver: { id: 'third-driver', version: '7' },
    model: { provider: 'mock', id: 'model' }, lineage }
  const context: PortableAgentContextV1 = { version: 1, source, items: [{ id: 'message', role: 'user',
    content: [{ kind: 'text', text: 'secret stays: pełna treść' }], provenance: { kind: 'user' } }],
  effectiveItemIds: ['message'], compactions: [] }
  const snapshot: PrivateDriverSnapshotV1 = { version: 1, driverId: 'third-driver', driverRevision: 'revision',
    schemaVersion: 9, context: { privateValue: 'preserve without interpretation' } }
  const header = { type: 'session', version: 3, id: 'root', createdAt: 1, isSeeded: false,
    delegationDepth: 0, importLineage: lineage }
  const selection = { type: 'agent/driver-selected', seq: 0, time: 1, data: { version: 1, driverId: 'third-driver' } }
  return { source, context, snapshot, header, selection }
}

function payloads() {
  const input = fixture()
  return { 'root.jsonl': Buffer.from(`${JSON.stringify(input.header)}\n${JSON.stringify(input.selection)}\n`),
    'driver.json': Buffer.from(JSON.stringify(input.source)), 'context.json': Buffer.from(JSON.stringify(input.context)),
    'private.json': Buffer.from(JSON.stringify(input.snapshot)) } as Record<string, Uint8Array>
}

async function withArchive(files: Record<string, Uint8Array>, check: (path: string,
  manifest: DshSessionArchiveManifestV1) => Promise<void>): Promise<void> {
  const manifest = completeDshArchiveManifestV1({ rootSessionId: 'root', sessionLogPath: 'root.jsonl',
    driverStatePath: 'driver.json', contextPath: 'context.json', privateSnapshotPath: files['private.json'] ? 'private.json' : null,
    workspace: { sourceCwd: null, fingerprint: null,
      snapshot: Object.keys(files).some(path => path.startsWith('workspace/')) ? { prefix: 'workspace', complete: true } : null } }, Object.entries(files).map(([path, bytes]) => {
    const kind: DshArchiveEntryV1['kind'] = path.startsWith('workspace/') ? 'workspace'
      : (path.startsWith('audit/') || path.startsWith('media/') || path.startsWith('files/')) ? 'attachment' : path.endsWith('.jsonl') ? 'session-log'
        : path.startsWith('driver') ? 'driver-state' : path.startsWith('context') ? 'portable-context' : 'private-snapshot'
    return { path, kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }))
  const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-bundle-'))
  try {
    const path = join(directory, 'private.zip')
    await writeFile(path, zipSync({ ...files, 'manifest.json': Buffer.from(JSON.stringify(manifest)) }), { mode: 0o600 })
    await check(path, manifest)
    const remaining = await readdir(directory)
    expect(remaining.filter(name => !name.startsWith('.dsh-workspace-import-'))).toEqual(['private.zip'])
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function encoded(value: unknown): Uint8Array { return Buffer.from(JSON.stringify(value)) }

describe('portable archive source metadata', () => {
  it('preserves complete data and a third driver private envelope without dispatching an agent', async () => {
    await withArchive(payloads(), async (path, manifest) => {
      const result = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      expect(result.bundle).toEqual({ context: fixture().context, privateSnapshot: fixture().snapshot })
      expect(result.root.artifact.header.importLineage).toEqual(result.bundle.context.source.lineage)
    })
  })

  it('accepts an archive without private state or lineage', async () => {
    const input = fixture()
    const { lineage: _lineage, ...source } = input.source
    const { importLineage: _importLineage, ...header } = input.header
    const files = payloads()
    delete files['private.json']
    files['driver.json'] = encoded(source)
    files['context.json'] = encoded({ ...input.context, source })
    files['root.jsonl'] = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify(input.selection)}\n`)
    await withArchive(files, async (path, manifest) => {
      const result = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      expect(result.bundle).not.toHaveProperty('privateSnapshot')
      expect(result.bundle.context.source).not.toHaveProperty('lineage')
    })
  })

  it.each([
    ['driver.json', { ...fixture().source, version: 999 }, /invalid canonical/],
    ['context.json', { ...fixture().context, version: 999 }, /invalid canonical/],
    ['context.json', { ...fixture().context, effectiveItemIds: ['missing'] }, /invalid canonical/],
    ['driver.json', { ...fixture().source, model: { provider: 'other', id: 'model' } }, /source disagree/],
    ['driver.json', { ...fixture().source, sessionId: 'other' }, /source disagree/],
    ['private.json', { ...fixture().snapshot, driverId: 'codex' }, /envelope or owner/],
    ['private.json', { ...fixture().snapshot, schemaVersion: 0 }, /envelope or owner/],
  ] as const)('rejects inconsistent %s metadata', async (entry, value, error) => {
    await withArchive({ ...payloads(), [entry]: encoded(value) }, async (path, manifest) => {
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow(error)
    })
  })

  it.each(['driver-extra.json', 'context-extra.json', 'private-extra.json'])('rejects ambiguous %s', async (name) => {
    await withArchive({ ...payloads(), [name]: encoded({}) }, async (path, manifest) => {
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow('ambiguous')
    })
  })

  it.each(['missing', 'different', 'duplicate'])('rejects %s durable driver selection', async (variant) => {
    const { header, selection } = fixture()
    const events = variant === 'missing' ? [] : variant === 'duplicate' ? [selection, { ...selection, seq: 1 }]
      : [{ ...selection, data: { version: 1, driverId: 'other' } }]
    const files = { ...payloads(), 'root.jsonl': Buffer.from([header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n') }
    await withArchive(files, async (path, manifest) => {
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow('durable driver selection')
    })
  })

  it('rejects lineage disagreement even when driver and context agree', async () => {
    const input = fixture()
    const source = { ...input.source, lineage: { ...input.source.lineage, importId: 'different-import' } }
    await withArchive({ ...payloads(), 'driver.json': encoded(source), 'context.json': encoded({ ...input.context, source }) },
      async (path, manifest) => {
        await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow('lineage disagrees')
      })
  })

  it.each([Buffer.from('{'), Buffer.from([0xff])])('rejects invalid metadata encoding', async (bytes) => {
    await withArchive({ ...payloads(), 'context.json': bytes }, async (path, manifest) => {
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow('invalid metadata JSON')
    })
  })
})

function auditArchive(variant = 'valid') {
  const files = payloads()
  const blob = Buffer.from('{"private":"full tool arguments"}')
  const sha256 = createHash('sha256').update(blob).digest('hex')
  const bytes = blob.length + (variant === 'wrong-size' ? 1 : 0)
  const receipt = { type: 'codex/artifact-v1', data: { version: 1, threadId: 'thread', sha256, bytes,
    mediaType: 'application/json', name: `dsh-audit-${sha256}.blob` } }
  const fact = { version: 1, sequence: 1, eventId: 'event', time: 1, threadId: 'thread', turn: 1,
    kind: 'tool/request', codexCallId: 'call', name: 'tool',
    arguments: { kind: 'artifact', sha256, bytes, mediaType: 'application/json' } }
  const audit = { type: 'codex/audit-v1', data: fact }
  let events: unknown[] = [receipt, audit]
  if (variant === 'missing-receipt') events = [audit]
  if (variant === 'late-receipt') events = [audit, receipt]
  if (variant === 'foreign-thread') events = [{ ...receipt, data: { ...receipt.data, threadId: 'other' } }, audit]
  if (variant === 'gap') events = [receipt, { ...audit, data: { ...fact, sequence: 2 } }]
  if (variant === 'duplicate-id') events = [receipt, audit, { ...audit, data: { ...fact, sequence: 2 } }]
  if (variant === 'duplicate-receipt') events = [receipt, receipt, audit]
  if (variant === 'pending-compaction') events = [receipt, audit, { type: 'codex/audit-v1', data: {
    version: 1, sequence: 2, eventId: 'pending', time: 1, threadId: 'thread', turn: 1,
    kind: 'compaction/pending', compactionId: 'compaction', effectiveHistory: { kind: 'inline', value: [] },
  } }]
  const { header, selection } = fixture()
  if (variant === 'foreign-session') {
    events = [audit]
    files['child.jsonl'] = Buffer.from(JSON.stringify({ ...header, id: 'child', parentSession: 'root', delegationDepth: 1, importLineage: undefined })
      + '\n' + JSON.stringify({ ...receipt, seq: 0, time: 1 }) + '\n')
  }
  files['root.jsonl'] = Buffer.from([header, selection,
    ...events.map((event, index) => ({ ...(event as object), seq: index + 1, time: 1 }))]
    .map(value => JSON.stringify(value)).join('\n') + '\n')
  if (variant !== 'missing-blob') files[`audit/${sha256}.blob`] = variant === 'wrong-hash' ? Buffer.from('changed') : blob
  return files
}

describe('archive audit ownership and references', () => {
  it('accepts a receipt-owned blob without exposing its contents in the preview', async () => {
    await withArchive(auditArchive(), async (path, manifest) => {
      const result = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      expect(result.root.artifact.events).toHaveLength(3)
      expect(result.bundle.context).toEqual(fixture().context)
    })
  })

  it.each(['missing-blob', 'wrong-hash', 'wrong-size', 'missing-receipt', 'late-receipt',
    'foreign-thread', 'foreign-session', 'gap', 'duplicate-id', 'duplicate-receipt', 'pending-compaction'])
  ('rejects %s even with a coherent ZIP inventory', async (variant) => {
    await withArchive(auditArchive(variant), async (path, manifest) => {
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow(/audit|artifact|compaction/)
    })
  })
})

function checkpointArchive(variant = 'valid') {
  const checkpoint = JSON.parse(readFileSync(new URL('../../../core/agent-codex/tests/fixtures/context-snapshot-v2-rust.json',
    import.meta.url), 'utf8')) as Record<string, unknown>
  const content = JSON.stringify(variant === 'changed-history' ? { ...checkpoint, effectiveHistory: [] } : checkpoint)
  const blob = Buffer.from(variant === 'truncated-json' ? content.slice(0, -1) : content)
  const sha256 = createHash('sha256').update(blob).digest('hex')
  const events: unknown[] = [{ type: 'codex/artifact-v1', seq: 1, time: 1, data: {
    version: 1, threadId: 'thread-1', sha256, bytes: blob.length, mediaType: 'application/json',
    name: `dsh-audit-${sha256}.blob`,
  } }]
  let sequence = 0
  const fact = (data: Record<string, unknown>) => {
    sequence++
    events.push({ type: 'codex/audit-v1', seq: sequence + 1, time: 1, data: {
      version: 1, sequence, eventId: `event-${sequence}`, time: 1, threadId: 'thread-1', turn: 1, ...data,
    } })
  }
  fact({ kind: 'context/config', config: { kind: 'inline', value: variant === 'wrong-config' ? {} : checkpoint.contextConfig } })
  const compactions = checkpoint.compactions as { id: string; replacementHistory: unknown[] }[]
  for (const compaction of variant === 'missing-compaction' ? compactions.slice(0, -1) : compactions) {
    fact({ kind: 'compaction/pending', compactionId: compaction.id,
      effectiveHistory: { kind: 'inline', value: compaction.replacementHistory }, priorRolloutSha256: 'a'.repeat(64) })
    fact({ kind: 'compaction/installed', compactionId: compaction.id,
      effectiveHistory: { kind: 'inline', value: compaction.replacementHistory } })
  }
  fact({ kind: 'checkpoint', checkpointId: 'turn:turn-1', effectiveHistorySha256: checkpoint.effectiveHistorySha256,
    snapshot: { kind: 'artifact', sha256, bytes: blob.length, mediaType: 'application/json' } })
  const { header, selection } = fixture()
  return { ...payloads(), [`audit/${sha256}.blob`]: blob,
    'root.jsonl': Buffer.from([header, selection, ...events].map(value => JSON.stringify(value)).join('\n') + '\n') }
}

describe('archive checkpoint audit verification', () => {
  it('accepts a Rust-produced V2 checkpoint with matching configuration and installations', async () => {
    await withArchive(checkpointArchive(), async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      expect(preview.root.artifact.events.at(-1)?.type).toBe('codex/audit-v1')
    })
  })

  it.each(['changed-history', 'missing-compaction', 'wrong-config', 'truncated-json'])
  ('rejects %s inside an otherwise valid archive', async (variant) => {
    await withArchive(checkpointArchive(variant), async (path, manifest) => {
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow()
    })
  })

  it('rejects cancelled checkpoint preview', async () => {
    await withArchive(checkpointArchive(), async (path, manifest) => {
      const controller = new AbortController()
      controller.abort(new Error('cancel checkpoint preview'))
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog, {}, controller.signal))
        .rejects.toThrow('cancel checkpoint preview')
    })
  })
})

function attachmentArchive(variant = 'valid', bytes = Uint8Array.of(1, 2, 3, 4)) {
  const files = payloads()
  const hash = createHash('sha256').update(bytes).digest('hex')
  const id = `sha256:${hash}`
  const image = { attachmentId: id as never, mediaType: 'image/png' as const, bytes: bytes.length, width: 2, height: 2 }
  const file = { attachmentId: id as never, name: 'file.txt', bytes: variant === 'wrong-size' ? 99 : bytes.length }
  const { header, selection, context } = fixture()
  const message = createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'image', attachment: image }, { type: 'file', attachment: file },
    ...['two-names', 'ambiguous-file'].includes(variant) ? [{ type: 'file' as const, attachment: { ...file, name: 'second.txt' } }] : [],
  ] })
  const events = [{ type: 'user/message', seq: 1, time: 1, surfaceOp: 'append', data: message }]
  if (variant === 'conflicting-image' || variant === 'conflicting-file') {
    events.push({ type: 'user/message', seq: 2, time: 2, surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'user' }, content: variant === 'conflicting-image'
        ? [{ type: 'image', attachment: { ...image, width: 3 } }]
        : [{ type: 'file', attachment: { ...file, bytes: 99 } }] }) })
  }
  files['root.jsonl'] = Buffer.from([header, selection, ...events].map(value => JSON.stringify(value)).join('\n') + '\n')
  files[`media/${hash}.png`] = variant === 'wrong-image-hash' ? Uint8Array.of(4, 3, 2, 1) : bytes
  files[`files/${hash.slice(0, 2)}/${hash}/file.txt`] = variant === 'wrong-file-hash' ? Uint8Array.of(4, 3, 2, 1) : bytes
  if (['two-names', 'ambiguous-file'].includes(variant)) files[`files/${hash.slice(0, 2)}/${hash}/second.txt`] = bytes
  if (variant === 'missing-image') delete files[`media/${hash}.png`]
  if (variant === 'missing-file') delete files[`files/${hash.slice(0, 2)}/${hash}/file.txt`]
  files['context.json'] = encoded({ ...context, items: [{ ...context.items[0], content: [
    { kind: 'attachment', attachmentId: id, mediaType: 'image/png' },
    { kind: 'tool-result', callId: 'historical-call', isError: false, content: [{ kind: 'attachment',
      attachmentId: id, mediaType: variant === 'unsupported-image' ? 'image/unsupported' : 'application/octet-stream',
      ...['unnamed-file', 'ambiguous-file'].includes(variant) ? {} : { name: variant === 'wrong-name' ? 'other.txt' : 'file.txt' },
    }] },
    ...variant === 'two-names' ? [{ kind: 'attachment', attachmentId: id, mediaType: 'application/octet-stream', name: 'second.txt' }] : [],
  ] }] })
  return files
}

describe('archive ordinary attachment references', () => {
  it('resolves shared image/file digests and multiple names without overwriting references', async () => {
    await withArchive(attachmentArchive('two-names'), async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      const resolved = resolveDshArchiveAttachments(preview, manifest)
      expect(resolved.size).toBe(3)
      expect([...resolved.values()].map(block => [block.type, block.attachment.name]))
        .toEqual([['image', undefined], ['file', 'file.txt'], ['file', 'second.txt']])
      const first = preview.bundle.context.items[0]!.content[0]!
      if (first.kind !== 'attachment') throw new Error('missing fixture attachment')
      expect(resolved.get(portableAttachmentKey(first))).toMatchObject({ type: 'image', attachment: { width: 2, height: 2 } })
    })
  })

  it('refuses ambiguous unnamed files and missing logged metadata', async () => {
    await withArchive(attachmentArchive('ambiguous-file'), async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      expect(() => resolveDshArchiveAttachments(preview, manifest)).toThrow('ambiguous logged file')
    })
    await withArchive(attachmentArchive(), async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      expect(() => resolveDshArchiveAttachments({ ...preview, logs: [] }, manifest)).toThrow('missing logged image')
    })
  })


  it.each(['valid', 'unnamed-file'])('accepts %s references in logs and nested canonical tool results', async (variant) => {
    await withArchive(attachmentArchive(variant), async (path, manifest) => {
      expect((await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).bundle.context.items).toHaveLength(1)
    })
  })

  it.each(['wrong-size', 'wrong-image-hash', 'wrong-file-hash', 'missing-image', 'missing-file',
    'conflicting-image', 'conflicting-file', 'wrong-name', 'unsupported-image'])
  ('rejects %s despite internally matching ZIP hashes', async (variant) => {
    await withArchive(attachmentArchive(variant), async (path, manifest) => {
      await expect(readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)).rejects.toThrow(/attachment|image/)
    })
  })
})


describe('archive source projection reader', () => {
  it('supplies verified bytes to a third source driver and rejects undeclared requests', async () => {
    const bytes = Buffer.from('third-driver artifact')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await withArchive({ ...payloads(), [`audit/${sha256}.blob`]: bytes }, async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      let requested = sha256
      const live = vi.fn(() => { throw new Error('live source must not run') })
      const source: AgentTransferSourcePort = { driverId: 'third-driver', exportPortableContext: live,
        async exportArchivedContext({ session, readArtifact }) {
          expect(session.id).toBe('root')
          const chunks = []
          for await (const chunk of readArtifact(requested, bytes.length)) chunks.push(chunk)
          expect(Buffer.concat(chunks)).toEqual(bytes)
          return preview.bundle
        },
      }
      await verifyDshSessionArchiveProjection(path, manifest, preview, source)
      expect(live).not.toHaveBeenCalled()
      requested = 'a'.repeat(64)
      await expect(verifyDshSessionArchiveProjection(path, manifest, preview, source)).rejects.toThrow('undeclared artifact')
    })
  })
})


describe('archive destination compatibility preview', () => {
  function ports() {
    const input = fixture()
    const source = { driverId: input.source.driver.id, exportPortableContext: vi.fn(),
      exportArchivedContext: vi.fn(async () => ({ context: input.context, privateSnapshot: input.snapshot })) }
    const capabilities = { driverId: source.driverId, supportedContextVersions: [1],
      supportedPrivateSnapshotVersions: [9], supportedPrivateRevisions: ['revision'],
      supportedOpaqueNamespaces: [], availableModels: [input.source.model] }
    const target = { describeAuthentication: vi.fn(async (): Promise<LlmAuthenticationInfo> => ({ status: 'unverified' })), driverId: source.driverId, importCapabilities: vi.fn(async () => capabilities),
      importPortableContext: vi.fn(), createImportedAgent: vi.fn() }
    return { source, target, capabilities, model: input.source.model }
  }

  it('imports a verified ZIP once through its archive source, with a fresh identity and explicit warnings', async () => {
    const { source, target, model } = ports()
    await withArchive(payloads(), async (path) => {
      const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'keep-workspace', path: dirname(path) } })
      expect(prepared.targetSessionId).not.toBe('root')
      await expect(prepared.commit(false)).rejects.toThrow('warnings require acknowledgment')
      expect(target.importPortableContext).not.toHaveBeenCalled()
      expect(target.createImportedAgent).not.toHaveBeenCalled()
      expect(prepared.preview.workspace.fingerprintComparison).toBe('unverified')
      Object.assign(prepared.preview.bundle.context.items[0]!.content[0]!, { text: 'mutated review' })
      const first = prepared.commit(true)
      expect(prepared.commit(true)).toBe(first)
      await first
      expect(source.exportPortableContext).not.toHaveBeenCalled()
      expect(target.importPortableContext).toHaveBeenCalledWith(expect.objectContaining({
        context: fixture().context, privateSnapshot: fixture().snapshot, targetSessionId: prepared.targetSessionId,
        lineage: expect.objectContaining({ sourceSessionId: 'root', sourceDriverId: source.driverId }) as unknown,
      }))
      expect(target.createImportedAgent).toHaveBeenCalledTimes(1)
      expect(target.createImportedAgent).toHaveBeenCalledWith(undefined, expect.objectContaining({ cwd: dirname(path) }))
    })
  })

  it('restores attachments before target preparation and never publishes after store failure', async () => {
    const { source, target, model } = ports()
    await withArchive(attachmentArchive('two-names'), async (path, manifest) => {
      const bundle = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      source.exportArchivedContext.mockResolvedValue({ context: bundle.bundle.context, privateSnapshot: fixture().snapshot })
      const store = recordingAttachmentStore()
      target.importPortableContext.mockImplementation(() => {
        expect([...store.saved.keys()].sort()).toEqual(['file.txt', 'image', 'second.txt'])
        return Promise.resolve('prepared')
      })
      const options = { path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store, workspace: { action: 'keep-workspace' as const, path: dirname(path) } }
      await (await prepareDshSessionArchiveImport(options)).commit(true)
      expect(target.createImportedAgent).toHaveBeenCalledWith('prepared', expect.any(Object))
      target.importPortableContext.mockClear()
      target.createImportedAgent.mockClear()
      store.saveFileStream.mockRejectedValue(new Error('store failure'))
      await expect((await prepareDshSessionArchiveImport(options)).commit(true)).rejects.toThrow('store failure')
      expect(target.importPortableContext).not.toHaveBeenCalled()
      expect(target.createImportedAgent).not.toHaveBeenCalled()
      expect(store.saved.has('image')).toBe(true)
    })
  })

  it.each(['model', 'archive', 'cancel', 'publisher'] as const)('refuses a changed %s or failed publication without retrying the attempt', async (failure) => {
    const { source, target, model, capabilities } = ports()
    const abort = new AbortController()
    await withArchive(payloads(), async (path) => {
      const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store: recordingAttachmentStore(), signal: abort.signal,
        workspace: { action: 'keep-workspace', path: dirname(path) } })
      if (failure === 'model') capabilities.availableModels.length = 0
      if (failure === 'archive') await writeFile(path, 'invalid ZIP')
      if (failure === 'cancel') abort.abort(new Error('cancel import probe'))
      if (failure === 'publisher') target.createImportedAgent.mockRejectedValue(new Error('publication probe'))
      const attempt = prepared.commit(true)
      await expect(attempt).rejects.toThrow()
      expect(prepared.commit(true)).toBe(attempt)
      expect(target.createImportedAgent).toHaveBeenCalledTimes(failure === 'publisher' ? 1 : 0)
    })
  })

  it('rejects a replaced workspace directory even when its path and content comparison are unchanged', async () => {
    const { source, target, model } = ports()
    await withArchive(payloads(), async (path) => {
      const destination = join(dirname(path), 'destination')
      const moved = join(dirname(path), 'moved')
      await mkdir(destination)
      try {
        const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
          source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'keep-workspace', path: destination } })
        await rename(destination, moved)
        await mkdir(destination)
        await expect(prepared.commit(true)).rejects.toThrow('workspace changed')
        expect(target.createImportedAgent).not.toHaveBeenCalled()
      } finally { await rm(destination, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }) }
    })
  })

  it('requires another review when recognized workspace content changes after preview', async () => {
    const { source, target, model } = ports()
    await withArchive(payloads(), async (path, manifest) => {
      const destination = join(dirname(path), 'destination')
      await mkdir(destination)
      try {
        await writeFile(join(destination, 'user.txt'), 'before')
        const fingerprint = await fingerprintDshWorkspace(destination)
        const currentManifest = { ...manifest, workspace: { ...manifest.workspace, ...fingerprint } }
        await writeFile(path, zipSync({ ...payloads(), 'manifest.json': encoded(currentManifest) }))
        const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
          source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'keep-workspace', path: destination } })
        expect(prepared.preview.workspace.fingerprintComparison).toBe('matching-content')
        await writeFile(join(destination, 'user.txt'), 'after')
        await expect(prepared.commit(true)).rejects.toThrow('workspace changed')
        expect(target.createImportedAgent).not.toHaveBeenCalled()
        expect(await readFile(join(destination, 'user.txt'), 'utf8')).toBe('after')
      } finally { await rm(destination, { recursive: true, force: true }) }
    })
  })

  it('refuses a missing workspace without creating it', async () => {
    const { source, target, model } = ports()
    await withArchive(payloads(), async (path) => {
      await expect(prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'keep-workspace', path: join(dirname(path), 'absent') } }))
        .rejects.toThrow('requires an existing directory')
      expect(target.createImportedAgent).not.toHaveBeenCalled()
    })
  })

  it.each([false, true])('creates a workspace from the archive and rolls it back on publication failure=%s', async (fail) => {
    const { source, target, model } = ports()
    await withArchive({ ...payloads(), 'workspace/data': Buffer.from('snapshot bytes') }, async (path) => {
      const destination = join(dirname(path), 'project')
      target.createImportedAgent.mockImplementation(async () => {
        expect(await readFile(join(destination, 'data'), 'utf8')).toBe('snapshot bytes')
        if (fail) throw new Error('publisher failed')
      })
      const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'apply-snapshot', path: destination } })
      expect(prepared.preview.workspace.targetExists).toBe(false)
      await expect(prepared.commit(false)).rejects.toThrow('warnings require acknowledgment')
      if (fail) await expect(prepared.commit(true)).rejects.toThrow('publisher failed')
      else {
        await prepared.commit(true)
        expect(await readFile(join(destination, 'data'), 'utf8')).toBe('snapshot bytes')
        await rm(destination, { recursive: true })
      }
      expect(target.createImportedAgent).toHaveBeenCalledOnce()
      expect(source.exportPortableContext).not.toHaveBeenCalled()
    })
  })

  it.each([false, true])('reports cleanup independently of publisher failure=%s', async (failPublisher) => {
    const { source, target, model } = ports()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await withArchive({ ...payloads(), 'workspace/data': Buffer.from('snapshot bytes') }, async (path) => {
      const destination = join(dirname(path), 'project')
      const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'apply-snapshot', path: destination } })
      if (failPublisher) target.createImportedAgent.mockRejectedValue(new Error('publisher failed'))
      let retained: string | undefined
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (String(path).includes('/.dsh-workspace-')) {
          retained = String(path)
          throw new Error('cleanup failed')
        }
        return actual.rm(path, options)
      })
      try {
        if (failPublisher) {
          await expect(prepared.commit(true)).rejects.toMatchObject({ cause: { message: 'publisher failed' },
            errors: [expect.objectContaining({ message: 'publisher failed' }) as unknown,
              expect.objectContaining({ name: 'DshArchiveStagingCleanupError' }) as unknown] })
          await expect(readdir(destination)).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          const result = await prepared.commit(true)
          expect(result.stagingCleanup?.path).toBe(retained)
          expect(await prepared.commit(true)).toBe(result)
          expect(await readFile(join(destination, 'data'), 'utf8')).toBe('snapshot bytes')
          await actual.rm(destination, { recursive: true })
        }
        expect(target.createImportedAgent).toHaveBeenCalledOnce()
        expect(retained).toBeDefined()
        expect(await readdir(retained!)).toContain('payloads')
      } finally {
        vi.mocked(rm).mockReset()
        if (retained !== undefined) await actual.rm(retained, { recursive: true, force: true })
      }
    })
  })

  it.each(['intent', 'materialized'])('refuses replacement publication when durable %s recording fails', async (phase) => {
    const { source, target, model } = ports()
    const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
    await withArchive({ ...payloads(), 'workspace/data': Buffer.from('snapshot') }, async (path) => {
      const parent = dirname(path)
      const destination = join(parent, 'existing')
      await mkdir(destination)
      await writeFile(join(destination, 'user-data'), 'preserve original')
      const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: parent, catalog: sessionFormatCatalog,
        source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'apply-snapshot', path: destination } })
      vi.mocked(writeFileAtomic).mockImplementation(async (path, data, options) => {
        if (path.includes('.dsh-workspace-import-') && data.includes(`"phase":"${phase}"`)) throw new Error('journal failure')
        await actual.writeFileAtomic(path, data, options)
      })
      try {
        await expect(prepared.commit(true, true)).rejects.toThrow('journal failure')
        expect(target.createImportedAgent).not.toHaveBeenCalled()
        expect(await readdir(destination)).toEqual(['user-data'])
        expect(await readFile(join(destination, 'user-data'), 'utf8')).toBe('preserve original')
        const backups = (await readdir(parent)).filter(name => name.startsWith('.dsh-workspace-backup-'))
        expect(backups).toHaveLength(1)
        expect(await readFile(join(parent, backups[0]!, 'workspace', 'user-data'), 'utf8')).toBe('preserve original')
      } finally {
        vi.mocked(writeFileAtomic).mockReset()
        await rm(destination, { recursive: true, force: true })
        for (const name of await readdir(parent)) {
          if (name.startsWith('.dsh-workspace-backup-')) await rm(join(parent, name), { recursive: true, force: true })
        }
      }
    })
  })

  it('requires a snapshot and separate confirmation before replacing existing files', async () => {
    const { source, target, model } = ports()
    await withArchive(payloads(), async (path) => {
      await expect(prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action: 'apply-snapshot', path: dirname(path) } }))
        .rejects.toThrow('requires an archived snapshot')
    })
    await withArchive({ ...payloads(), 'workspace/data': Buffer.from('snapshot') }, async (path) => {
      const store = recordingAttachmentStore()
      const prepared = await prepareDshSessionArchiveImport({ path, stagingParent: dirname(path), catalog: sessionFormatCatalog,
        source, target, targetModel: model, store, workspace: { action: 'apply-snapshot', path: dirname(path) } })
      expect(prepared.replacesExistingWorkspace).toBe(true)
      await expect(prepared.commit(true)).rejects.toThrow('separate confirmation')
      expect(target.createImportedAgent).not.toHaveBeenCalled()
      expect(target.importPortableContext).not.toHaveBeenCalled()
      expect(store.saved.size).toBe(0)
    })
  })

  it.each(['context-only'] as const)('refuses unsupported %s before invoking ports', async (action) => {
    const { source, target, model } = ports()
    await expect(prepareDshSessionArchiveImport({ path: '/unused.zip', stagingParent: '/unused', catalog: sessionFormatCatalog,
      source, target, targetModel: model, store: recordingAttachmentStore(), workspace: { action, path: '/unused' } }))
      .rejects.toThrow('workspace action is not implemented')
    expect(source.exportArchivedContext).not.toHaveBeenCalled()
  })

  it('previews uploaded bytes without invoking import or live export, and refuses invalid uploads', async () => {
    const { source, target } = ports()
    const getTransferPorts = vi.fn(() => ({ source, target }))
    const url = 'http://host/api/session.import.preview?driverId=third-driver&provider=mock&model=model'
    const request = (bytes: Uint8Array): Request => new Request(url, {
      method: 'POST', headers: { 'content-type': 'application/zip' }, body: Buffer.from(bytes),
    })
    await withArchive(payloads(), async (path) => {
      const bytes = await readFile(path)
      const response = await handleDshImportPreview(request(bytes), { getTransferPorts })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ source: fixture().source, targetDriverId: 'third-driver',
        workspace: { targetExists: false }, assessment: { fidelity: 'same-driver' } })
      expect(target.importPortableContext).not.toHaveBeenCalled()
      expect(source.exportPortableContext).not.toHaveBeenCalled()
      expect((await handleDshImportPreview(request(bytes), { getTransferPorts }, { maxArchiveBytes: bytes.length - 1 })).status).toBe(413)
      expect((await handleDshImportPreview(request(bytes), { getTransferPorts }, { maxEntries: 1 })).status).toBe(422)
    })
    source.exportArchivedContext.mockClear()
    const corrupt = await handleDshImportPreview(request(new Uint8Array([1, 2, 3])), { getTransferPorts })
    expect(corrupt.status).toBe(422)
    expect(source.exportArchivedContext).not.toHaveBeenCalled()
    const legacy = await handleDshImportPreview(request(zipSync({ 'log.jsonl': new Uint8Array() })), { getTransferPorts })
    expect(await legacy.json()).toMatchObject({ error: 'DSH_ARCHIVE_MANIFEST_REQUIRED' })
    expect((await handleDshImportPreview(new Request(url, { method: 'POST', body: 'data' }), { getTransferPorts })).status).toBe(415)
    expect((await handleDshImportPreview(request(new Uint8Array()), undefined)).status).toBe(503)
  })

  it('cleans private staging when the streamed upload is cancelled', async () => {
    const { source, target } = ports()
    const controller = new AbortController()
    const init = { method: 'POST', headers: { 'content-type': 'application/zip' }, duplex: 'half', signal: controller.signal,
      body: new ReadableStream<Uint8Array>({ pull(stream) {
        stream.enqueue(new Uint8Array([1]))
        controller.abort(new Error('cancel upload'))
      } }, { highWaterMark: 0 }) }
    const request = new Request('http://host/api/session.import.preview?driverId=third-driver&provider=mock&model=model', init)
    await expect(handleDshImportPreview(request, { getTransferPorts: () => ({ source, target }) })).rejects.toThrow('cancel upload')
    expect(source.exportArchivedContext).not.toHaveBeenCalled()
    expect(target.importPortableContext).not.toHaveBeenCalled()
    expect(vi.mocked(mkdtemp).mock.calls.some(([prefix]) => prefix.includes('dsh-import-preview-'))).toBe(true)
  })

  it.each([true, false])('reports model availability %s without importing', async (available) => {
    const { source, target, capabilities, model } = ports()
    if (!available) capabilities.availableModels = []
    await withArchive(payloads(), async (path) => {
      const result = await previewDshSessionArchive(path, sessionFormatCatalog, source, target, model)
      expect(result.assessment.fidelity).toBe(available ? 'same-driver' : 'unsupported')
      expect(result.assessment.issues.map(issue => issue.code)).toEqual(available ? [] : ['model-unavailable'])
      expect(result.bundle.context).toEqual(fixture().context)
      expect(result.targetModel).toEqual(model)
      expect(target.importPortableContext).not.toHaveBeenCalled()
      expect(source.exportPortableContext).not.toHaveBeenCalled()
    })
  })

  it('refuses log-only archives before invoking either driver', async () => {
    const { source, target, model } = ports()
    await withArchive(payloads(), async (path) => {
      await writeFile(path, zipSync({ 'session.v3.jsonl': payloads()['root.jsonl']! }))
      await expect(previewDshSessionArchive(path, sessionFormatCatalog, source, target, model))
        .rejects.toMatchObject({ code: 'DSH_ARCHIVE_MANIFEST_REQUIRED' })
      expect(source.exportArchivedContext).not.toHaveBeenCalled()
      expect(target.importCapabilities).not.toHaveBeenCalled()
      expect(target.describeAuthentication).not.toHaveBeenCalled()
      expect(target.importPortableContext).not.toHaveBeenCalled()
    })
  })

  it('includes snapshot file conflicts in the combined preview without applying them', async () => {
    const { source, target, model } = ports()
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-archive-workspace-'))
    try {
      await writeFile(join(workspace, 'file.txt'), 'local')
      await withArchive({ ...payloads(), 'workspace/file.txt': Buffer.from('archived') }, async (path) => {
        const result = await previewDshSessionArchive(path, sessionFormatCatalog, source, target, model, {}, undefined, workspace)
        expect(result.workspaceEntries).toEqual([{ path: 'file.txt', kind: 'file', status: 'changed' }])
        expect(result.workspace.choices[0]?.fidelity).toBe('unverified')
        expect(readFileSync(join(workspace, 'file.txt'), 'utf8')).toBe('local')
        expect(target.importPortableContext).not.toHaveBeenCalled()
      })
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('rejects changed source projection before reading destination capabilities', async () => {
    const { source, target, model } = ports()
    const files = payloads()
    files['context.json'] = encoded({ ...fixture().context, items: [], effectiveItemIds: [] })
    await withArchive(files, async (path) => {
      await expect(previewDshSessionArchive(path, sessionFormatCatalog, source, target, model)).rejects.toThrow()
      expect(target.importCapabilities).not.toHaveBeenCalled()
      expect(target.importPortableContext).not.toHaveBeenCalled()
    })
  })

  it.each<LlmAuthenticationInfo>([
    { status: 'missing', reference: 'TARGET_KEY' }, { status: 'configured', reference: 'TARGET_KEY' },
    { status: 'provider-managed' }, { status: 'unverified' },
  ])('reports authentication $status separately from context fidelity', async (authentication) => {
    const { source, target, model } = ports()
    target.describeAuthentication.mockResolvedValue(authentication)
    await withArchive(payloads(), async (path) => {
      const result = await previewDshSessionArchive(path, sessionFormatCatalog, source, target, model)
      expect(result.authentication).toEqual(authentication)
      expect(result.assessment.fidelity).toBe('same-driver')
      expect(target.describeAuthentication).toHaveBeenCalledWith(model)
      expect(target.importPortableContext).not.toHaveBeenCalled()
    })
  })

  it('does not inspect credentials for an unavailable model', async () => {
    const { source, target, capabilities, model } = ports()
    capabilities.availableModels = []
    await withArchive(payloads(), async (path) => {
      expect((await previewDshSessionArchive(path, sessionFormatCatalog, source, target, model)).authentication)
        .toEqual({ status: 'unverified' })
      expect(target.describeAuthentication).not.toHaveBeenCalled()
    })
  })

  it('does not publish a preview when authentication inspection fails or is cancelled', async () => {
    const { source, target, model } = ports()
    await withArchive(payloads(), async (path) => {
      target.describeAuthentication.mockRejectedValueOnce(new Error('credential metadata unavailable'))
      await expect(previewDshSessionArchive(path, sessionFormatCatalog, source, target, model))
        .rejects.toThrow('credential metadata unavailable')
      const controller = new AbortController()
      target.describeAuthentication.mockImplementationOnce(async () => {
        controller.abort(new Error('cancel authentication'))
        return { status: 'unverified' }
      })
      await expect(previewDshSessionArchive(path, sessionFormatCatalog, source, target, model, {}, controller.signal))
        .rejects.toThrow('cancel authentication')
      expect(target.importPortableContext).not.toHaveBeenCalled()
    })
  })

  it('rejects inconsistent destination identity', async () => {
    const { source, target, capabilities, model } = ports()
    capabilities.driverId = 'wrong'
    await withArchive(payloads(), async (path) => {
      await expect(previewDshSessionArchive(path, sessionFormatCatalog, source, target, model)).rejects.toThrow('capabilities do not match')
      expect(target.importPortableContext).not.toHaveBeenCalled()
    })
  })

  it('does not publish a preview cancelled while reading capabilities', async () => {
    const { source, target, capabilities, model } = ports()
    const controller = new AbortController()
    target.importCapabilities.mockImplementation(async () => {
      controller.abort(new Error('cancel preview'))
      return capabilities
    })
    await withArchive(payloads(), async (path) => {
      await expect(previewDshSessionArchive(path, sessionFormatCatalog, source, target, model, {}, controller.signal))
        .rejects.toThrow('cancel preview')
      expect(target.importPortableContext).not.toHaveBeenCalled()
    })
  })
})


function recordingAttachmentStore() {
  const saved = new Map<string, Uint8Array>()
  return {
    saved,
    restoreImage: vi.fn(async (input: StoredImageAttachment) => {
      saved.set('image', Uint8Array.from(input.data))
      return structuredClone(input.ref)
    }),
    saveFileStream: vi.fn(async (input: SaveFileStreamAttachment) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of input.data) {
        expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024)
        chunks.push(chunk)
      }
      const data = Buffer.concat(chunks)
      saved.set(input.name!, data)
      return { attachmentId: AttachmentId(`sha256:${createHash('sha256').update(data).digest('hex')}`),
        name: input.name!, bytes: data.byteLength }
    }),
  }
}

describe('archive attachment restoration', () => {
  it('restores original images and streams files without remapping refs or duplicating repeated references', async () => {
    const bytes = new Uint8Array(200_000).fill(0x61)
    const files = attachmentArchive('valid', bytes)
    await withArchive(files, async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      // Repeated logs refer to shared objects, not independent writes.
      const store = recordingAttachmentStore()
      await restoreDshArchiveAttachments(path, manifest, { ...preview, logs: [...preview.logs, ...preview.logs] },
        store, dirname(path))
      expect(store.restoreImage).toHaveBeenCalledTimes(1)
      expect(store.saveFileStream).toHaveBeenCalledTimes(1)
      expect(store.saved.get('image')).toEqual(bytes)
      expect(store.saved.get('file.txt')).toEqual(Buffer.from(bytes))
    })
  })

  it('restores full unredacted audit blobs under their durable receipt names', async () => {
    const files = auditArchive()
    await withArchive(files, async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      const store = recordingAttachmentStore()
      await restoreDshArchiveAttachments(path, manifest, preview, store, dirname(path))
      const [name, data] = Object.entries(files).find(([name]) => name.startsWith('audit/'))!
      expect(store.saved.get(`dsh-audit-${name.slice(6)}`)).toEqual(Buffer.from(data))
      expect(store.restoreImage).not.toHaveBeenCalled()
      expect(store.saveFileStream).toHaveBeenCalledTimes(1)
    })
  })

  it('rejects archive changes before invoking any store operation', async () => {
    const files = attachmentArchive()
    await withArchive(files, async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      await writeFile(path, zipSync({ ...files, 'driver.json': encoded({ changed: true }),
        'manifest.json': encoded(manifest) }))
      const store = recordingAttachmentStore()
      await expect(restoreDshArchiveAttachments(path, manifest, preview, store, dirname(path))).rejects.toThrow()
      expect(store.restoreImage).not.toHaveBeenCalled()
      expect(store.saveFileStream).not.toHaveBeenCalled()
    })
  })

  it('propagates store failure and leaves shared objects alone after partial restoration', async () => {
    await withArchive(attachmentArchive(), async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      const store = recordingAttachmentStore()
      store.saveFileStream.mockRejectedValueOnce(new Error('storage failed'))
      await expect(restoreDshArchiveAttachments(path, manifest, preview, store, dirname(path))).rejects.toThrow('storage failed')
      expect(store.saved.get('image')).toEqual(Uint8Array.of(1, 2, 3, 4))
    })
  })

  it('rejects a changed file receipt and cancellation during bounded file reads', async () => {
    await withArchive(attachmentArchive('valid', new Uint8Array(200_000).fill(0x61)), async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      const store = recordingAttachmentStore()
      store.saveFileStream.mockImplementationOnce(async () => ({ attachmentId: AttachmentId('sha256:wrong'), name: 'file.txt', bytes: 0 }))
      await expect(restoreDshArchiveAttachments(path, manifest, preview, store, dirname(path))).rejects.toThrow('changed archived reference')
      const controller = new AbortController()
      store.saveFileStream.mockImplementationOnce(async (input) => {
        const chunks = input.data[Symbol.asyncIterator]()
        try {
          expect((await chunks.next()).done).toBe(false)
          controller.abort(new Error('cancel file read'))
          await chunks.next()
          throw new Error('unexpected complete read')
        } finally { await chunks.return?.() }
      })
      await expect(restoreDshArchiveAttachments(path, manifest, preview, store, dirname(path), {}, controller.signal))
        .rejects.toThrow('cancel file read')
    })
  })

  it('rejects reference changes and observes cancellation between store operations', async () => {
    await withArchive(attachmentArchive(), async (path, manifest) => {
      const preview = await readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      const store = recordingAttachmentStore()
      store.restoreImage.mockImplementationOnce(async input => ({ ...input.ref, width: 99 }))
      await expect(restoreDshArchiveAttachments(path, manifest, preview, store, dirname(path))).rejects.toThrow('changed archived reference')
      expect(store.saveFileStream).not.toHaveBeenCalled()
      const controller = new AbortController()
      store.restoreImage.mockImplementationOnce(async (input) => { controller.abort(); return input.ref })
      await expect(restoreDshArchiveAttachments(path, manifest, preview, store, dirname(path), {}, controller.signal)).rejects.toThrow()
      expect(store.saveFileStream).not.toHaveBeenCalled()
    })
  })
})
