import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, readdir, readlink, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zipSync, strToU8, Zip, ZipPassThrough } from 'fflate'
import { ZipFile } from 'yauzl'
import { describe, expect, it, vi } from 'vitest'
import { fingerprintDshWorkspace } from '../src/workspace-fingerprint.ts'
import { completeDshArchiveManifestV1 } from '../src/manifest-stream.ts'
import { DshArchiveManifestRequiredError, readDshSessionZipPayloads, validateDshSessionZip,
  withDshArchiveAttachments, withDshWorkspaceSnapshot } from '../src/zip-validation.ts'

function fixture() {
  const files = { 'session.jsonl': strToU8('pełna historia\n'), 'agent/driver.json': strToU8('{}'),
    'agent/context.json': strToU8('{"text":"secret remains"}') }
  const kinds = ['session-log', 'driver-state', 'portable-context'] as const
  const manifest = completeDshArchiveManifestV1({ rootSessionId: 'source', sessionLogPath: 'session.jsonl',
    driverStatePath: 'agent/driver.json', contextPath: 'agent/context.json', privateSnapshotPath: null,
    workspace: { sourceCwd: null, fingerprint: null, snapshot: null } }, Object.entries(files).map(([path, bytes], index) => ({
    path, kind: kinds[index]!, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  })))
  return { manifest, files: { ...files, 'manifest.json': strToU8(JSON.stringify(manifest)) } }
}

async function withZip(data: Uint8Array, check: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-zip-validation-'))
  const path = join(directory, 'input.zip')
  try {
    await writeFile(path, data, { mode: 0o600 })
    await check(path)
    expect(await readdir(directory)).toEqual(['input.zip'])
    if (process.platform === 'linux') {
      for (const fd of await readdir('/proc/self/fd')) {
        let target: string
        try { target = await readlink(`/proc/self/fd/${fd}`) } catch { continue /* fd closed concurrently */ }
        expect(target.startsWith(`${directory}/`)).toBe(false)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function streamedZip(entries: readonly [string, Uint8Array][]): Uint8Array {
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes) })
  for (const [name, bytes] of entries) {
    const file = new ZipPassThrough(name)
    zip.add(file)
    file.push(bytes, true)
  }
  zip.end()
  return Buffer.concat(chunks)
}

describe('portable ZIP container validation', () => {
  it.each([0, 6] as const)('validates stored/deflated archive at level %i without extracting', async (level) => {
    const { files, manifest } = fixture()
    await withZip(zipSync(files, { level }), async (path) => {
      expect(await validateDshSessionZip(path)).toEqual(manifest)
    })
  })

  it('accepts data descriptors and empty structural directories', async () => {
    const { files, manifest } = fixture()
    await withZip(streamedZip([['agent/', new Uint8Array()], ...Object.entries(files)]), async (path) => {
      expect(await validateDshSessionZip(path)).toEqual(manifest)
    })
  })

  it.each(['../escape', '/absolute', 'a\\b', 'C:drive', 'a//b', 'a/./b', 'a/../b', 'a\u0000b'])
  ('rejects unsafe path %s', async (name) => {
    await withZip(zipSync({ ...fixture().files, [name]: strToU8('x') }), async (path) => {
      await expect(validateDshSessionZip(path)).rejects.toThrow()
    })
  })

  it.each([
    ['agent/driver.json', 'agent/driver.json'], ['agent', 'agent/file'], ['agent/file', 'agent'], ['dir/', 'dir/'],
  ])('rejects duplicate or conflicting paths %s and %s', async (a, b) => {
    await withZip(streamedZip([[a, new Uint8Array()], [b, new Uint8Array()]]), async (path) => {
      await expect(validateDshSessionZip(path)).rejects.toThrow(/duplicate|conflict/)
    })
  })

  it('rejects missing, changed and extra manifest payloads', async () => {
    const { files } = fixture()
    const { 'agent/context.json': _context, ...missing } = files
    for (const archive of [missing, { ...files, 'agent/context.json': strToU8('changed') }, { ...files, extra: strToU8('x') }]) {
      await withZip(zipSync(archive), async (path) => { await expect(validateDshSessionZip(path)).rejects.toThrow() })
    }
    await withZip(zipSync({ 'session.jsonl': strToU8('legacy') }), async (path) => {
      await expect(validateDshSessionZip(path)).rejects.toThrow()
    })
  })

  it('rejects CRC corruption, truncation, symlinks, encryption, methods and header disagreement', async () => {
    const original = Buffer.from(zipSync(fixture().files, { level: 0 }))
    const central = original.indexOf(Buffer.from([0x50, 0x4b, 1, 2]))
    const mutations = [
      (data: Buffer) => { data.writeUInt32LE(0, central + 16) },
      (data: Buffer) => { data.writeUInt32LE(0, 14) },
      (data: Buffer) => { const offset = 30 + data.readUInt16LE(26) + data.readUInt16LE(28); data[offset] = data.readUInt8(offset) ^ 1 },
      (data: Buffer) => { data.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38) },
      (data: Buffer) => { data.writeUInt16LE(data.readUInt16LE(central + 8) | 1, central + 8) },
      (data: Buffer) => { data.writeUInt16LE(99, central + 10) },
      (data: Buffer) => { data[30] = 0x78 },
    ]
    for (const mutate of mutations) {
      const data = Buffer.from(original)
      mutate(data)
      await withZip(data, async (path) => { await expect(validateDshSessionZip(path)).rejects.toThrow() })
    }
    await withZip(original.subarray(0, original.length - 10), async (path) => {
      await expect(validateDshSessionZip(path)).rejects.toThrow()
    })
  })

  it.each(['session.jsonl', 'session.v1.jsonl', 'session.v2.jsonl', 'session.v3.jsonl'])
  ('explicitly refuses faithful restoration from a log-only %s archive', async (name) => {
    await withZip(zipSync({ [name]: strToU8('old log'), 'media/old.png': Uint8Array.of(1, 2, 3) }), async (path) => {
      await expect(validateDshSessionZip(path)).rejects.toMatchObject({
        name: 'DshArchiveManifestRequiredError', code: 'DSH_ARCHIVE_MANIFEST_REQUIRED',
      })
      await expect(validateDshSessionZip(path)).rejects.toThrow('cannot faithfully restore agent context')
    })
  })

  it('does not misclassify an invalid manifest or unsafe legacy payload as log-only compatibility', async () => {
    await withZip(zipSync({ ...fixture().files, 'manifest.json': strToU8('null') }), async (path) => {
      await expect(validateDshSessionZip(path)).rejects.not.toBeInstanceOf(DshArchiveManifestRequiredError)
    })
    await withZip(zipSync({ '../escape': strToU8('old log') }), async (path) => {
      await expect(validateDshSessionZip(path)).rejects.not.toBeInstanceOf(DshArchiveManifestRequiredError)
    })
  })

  it('enforces optional limits during decompression and counts the manifest', async () => {
    const { files } = fixture()
    await withZip(zipSync({ ...files, bomb: new Uint8Array(2_000_000) }), async (path) => {
      await expect(validateDshSessionZip(path, { maxEntryBytes: 4096 })).rejects.toThrow('maxEntryBytes')
    })
    await withZip(zipSync(files), async (path) => {
      await expect(validateDshSessionZip(path, { maxEntries: 3 })).rejects.toThrow('maxEntries')
      await expect(validateDshSessionZip(path, { maxTotalUncompressedBytes: 32 })).rejects.toThrow('maxTotalUncompressedBytes')
      const total = Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0)
      expect(await validateDshSessionZip(path, { maxTotalUncompressedBytes: total, maxEntries: 4 })).toEqual(fixture().manifest)
      await expect(validateDshSessionZip(path, { maxEntries: 0 })).rejects.toThrow('positive safe integer')
    })
  })

  it('honors cancellation before open and during decompression and releases readers', async () => {
    await withZip(zipSync({ ...fixture().files, bomb: new Uint8Array(8_000_000) }), async (path) => {
      await expect(validateDshSessionZip(path, {}, AbortSignal.abort())).rejects.toThrow()
      const controller = new AbortController()
      // oxlint-disable-next-line typescript/unbound-method -- called with the original ZipFile receiver below.
      const original = ZipFile.prototype.openReadStreamPromise
      const opened = vi.spyOn(ZipFile.prototype, 'openReadStreamPromise').mockImplementation(async function (this: ZipFile, entry, options) {
        const stream = await original.call(this, entry, options)
        stream.once('data', () => { controller.abort() })
        return stream
      })
      try { await expect(validateDshSessionZip(path, {}, controller.signal)).rejects.toThrow(/abort/i) }
      finally { opened.mockRestore() }
    })
  })
})


describe('verified ZIP payload reads', () => {
  it('returns only requested exact payloads after validating every entry', async () => {
    const { files } = fixture()
    await withZip(zipSync(files), async (path) => {
      const manifest = await validateDshSessionZip(path)
      const data = await readDshSessionZipPayloads(path, manifest, ['agent/context.json', 'session.jsonl'])
      expect([...data.keys()]).toEqual(['agent/context.json', 'session.jsonl'])
      expect(data.get('agent/context.json')).toEqual(Buffer.from(files['agent/context.json']))
      expect(data.get('session.jsonl')).toEqual(Buffer.from(files['session.jsonl']))
      expect(await readDshSessionZipPayloads(path, manifest, [])).toEqual(new Map())
    })
  })

  it('refuses undeclared, duplicate and manifest paths without exposing data', async () => {
    await withZip(zipSync(fixture().files), async (path) => {
      const manifest = await validateDshSessionZip(path)
      for (const paths of [['missing'], ['manifest.json'], ['../escape'], ['session.jsonl', 'session.jsonl']]) {
        await expect(readDshSessionZipPayloads(path, manifest, paths)).rejects.toThrow('duplicate or absent')
      }
    })
  })

  it('rejects changes to an unselected payload and changes to the validated manifest', async () => {
    const { files } = fixture()
    await withZip(zipSync(files), async (path) => {
      const manifest = await validateDshSessionZip(path)
      await writeFile(path, zipSync({ ...files, 'agent/driver.json': strToU8('{"changed":true}') }))
      await expect(readDshSessionZipPayloads(path, manifest, ['session.jsonl'])).rejects.toThrow()
      await writeFile(path, zipSync({ ...files,
        'manifest.json': strToU8(JSON.stringify({ ...manifest, rootSessionId: 'replacement' })) }))
      await expect(readDshSessionZipPayloads(path, manifest, ['session.jsonl'])).rejects.toThrow('manifest changed')
    })
  })

  it('rejects coherently replaced payloads even with an internally valid replacement manifest', async () => {
    const { files } = fixture()
    await withZip(zipSync(files), async (path) => {
      const manifest = await validateDshSessionZip(path)
      const changed = strToU8('{"new":"context"}')
      const replacement = { ...manifest, entries: manifest.entries.map(entry => entry.path === 'agent/context.json'
        ? { ...entry, bytes: changed.length, sha256: createHash('sha256').update(changed).digest('hex') } : entry) }
      await writeFile(path, zipSync({ ...files, 'agent/context.json': changed,
        'manifest.json': strToU8(JSON.stringify(replacement)) }))
      expect(await validateDshSessionZip(path)).toEqual(replacement)
      await expect(readDshSessionZipPayloads(path, manifest, ['agent/context.json'])).rejects.toThrow('manifest changed')
    })
  })

  it('counts unselected bytes against the policy and honors cancellation', async () => {
    await withZip(zipSync(fixture().files), async (path) => {
      const manifest = await validateDshSessionZip(path)
      await expect(readDshSessionZipPayloads(path, manifest, [], { maxTotalUncompressedBytes: 1 }))
        .rejects.toThrow('maxTotalUncompressedBytes')
      await expect(readDshSessionZipPayloads(path, manifest, ['session.jsonl'], {}, AbortSignal.abort()))
        .rejects.toThrow()
    })
  })
})

function workspaceFixture() {
  const base = fixture()
  const payloads = { 'workspace/nested/large.bin': new Uint8Array(2_000_000).fill(0x7b), 'workspace/empty': new Uint8Array() }
  const manifest = completeDshArchiveManifestV1({ ...base.manifest,
    workspace: { sourceCwd: '/source', fingerprint: null, snapshot: { prefix: 'workspace', complete: true } } }, [
    ...base.manifest.entries, ...Object.entries(payloads).map(([path, data]) => ({ path, kind: 'workspace' as const,
      bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })),
  ])
  return { manifest, payloads, files: { ...base.files, ...payloads, 'manifest.json': strToU8(JSON.stringify(manifest)) } }
}

describe('private workspace snapshot staging', () => {
  it.each([false, true])('preserves empty directories and content fingerprint, with consumer failure=%s', async (fail) => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-snapshot-source-'))
    try {
      const base = workspaceFixture()
      const directories = ['workspace/unused/deep', 'workspace/nested', 'workspace/unused']
      for (const directory of directories) await mkdir(join(source, directory.slice('workspace/'.length)), { recursive: true })
      for (const [path, bytes] of Object.entries(base.payloads)) await writeFile(join(source, path.slice('workspace/'.length)), bytes)
      const fingerprint = await fingerprintDshWorkspace(source)
      const manifest = { ...base.manifest, workspace: { ...base.manifest.workspace, ...fingerprint,
        snapshot: { prefix: 'workspace', complete: true, directories } } }
      await withZip(zipSync({ ...base.files, 'manifest.json': strToU8(JSON.stringify(manifest)) }), async (path) => {
        const staged = withDshWorkspaceSnapshot(path, manifest, dirname(path), async (directory) => {
          expect(await readdir(join(directory, 'unused/deep'))).toEqual([])
          expect(await fingerprintDshWorkspace(directory)).toEqual(fingerprint)
          if (fail) throw new Error('consumer failure')
        })
        if (fail) await expect(staged).rejects.toThrow('consumer failure')
        else await staged
      })
    } finally { await rm(source, { recursive: true, force: true }) }
  })

  it('refuses a complete directory snapshot whose declared fingerprint disagrees with restored content', async () => {
    const base = workspaceFixture()
    const manifest = { ...base.manifest, workspace: { ...base.manifest.workspace,
      fingerprint: '0'.repeat(64), fingerprintAlgorithm: 'dsh-workspace-content-v1' as const,
      snapshot: { prefix: 'workspace', complete: true, directories: ['workspace/nested'] } } }
    await withZip(zipSync({ ...base.files, 'manifest.json': strToU8(JSON.stringify(manifest)) }), async (path) => {
      const consume = vi.fn(async () => {})
      await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), consume)).rejects.toThrow('snapshot fingerprint differs')
      expect(consume).not.toHaveBeenCalled()
    })
  })

  it('leaves cancellation after consumer entry to the consumer transaction', async () => {
    const { manifest, files } = workspaceFixture()
    await withZip(zipSync(files), async (path) => {
      const controller = new AbortController()
      const result = await withDshWorkspaceSnapshot(path, manifest, dirname(path), async () => {
        controller.abort()
        return 'consumer committed'
      }, {}, controller.signal)
      expect(result).toBe('consumer committed')
    })
  })

  it('provides an empty directory for an explicitly empty snapshot', async () => {
    const base = fixture()
    const manifest = { ...base.manifest, workspace: { ...base.manifest.workspace, snapshot: { prefix: 'workspace', complete: true } } }
    await withZip(zipSync({ ...base.files, 'manifest.json': strToU8(JSON.stringify(manifest)) }), async (path) => {
      await withDshWorkspaceSnapshot(path, manifest, dirname(path), async (directory) => {
        expect(await readdir(directory)).toEqual([])
      })
    })
  })

  it('removes partial staging when conflicting file parents prevent creation', async () => {
    const base = workspaceFixture()
    const manifest = { ...base.manifest, entries: [...base.manifest.entries,
      { path: 'workspace/empty/child', kind: 'workspace' as const, bytes: 0, sha256: createHash('sha256').digest('hex') }] }
    await withZip(zipSync(base.files), async (path) => {
      const consume = vi.fn(async () => {})
      await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), consume)).rejects.toThrow()
      expect(consume).not.toHaveBeenCalled()
    })
  })

  it('streams complete and empty files into private staging and removes it after consumption', async () => {
    const { manifest, files, payloads } = workspaceFixture()
    await withZip(zipSync(files), async (path) => {
      let staged = ''
      const result = await withDshWorkspaceSnapshot(path, manifest, dirname(path), async (directory) => {
        staged = directory
        expect(await readFile(join(directory, 'nested/large.bin'))).toEqual(Buffer.from(payloads['workspace/nested/large.bin']))
        expect((await stat(join(directory, 'empty'))).size).toBe(0)
        expect(await readdir(directory)).toEqual(['empty', 'nested'])
        if (process.platform !== 'win32') {
          expect((await stat(dirname(directory))).mode & 0o777).toBe(0o700)
          expect((await stat(join(directory, 'empty'))).mode & 0o777).toBe(0o600)
        }
        return 'consumed'
      })
      expect(result).toBe('consumed')
      await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('does not expose snapshot files when a non-workspace payload or manifest changed', async () => {
    const { manifest, files } = workspaceFixture()
    const consume = vi.fn(async () => {})
    await withZip(zipSync({ ...files, 'session.jsonl': strToU8('corrupt') }), async (path) => {
      await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), consume)).rejects.toThrow('hash or size differs')
    })
    const changed = { ...manifest, rootSessionId: 'different' }
    await withZip(zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(changed)) }), async (path) => {
      await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), consume)).rejects.toThrow('manifest changed')
    })
    expect(consume).not.toHaveBeenCalled()
  })

  it('removes staging on consumer failure, limits and cancellation', async () => {
    const { manifest, files } = workspaceFixture()
    await withZip(zipSync(files), async (path) => {
      await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), async () => { throw new Error('consumer failed') }))
        .rejects.toThrow('consumer failed')
      const consume = vi.fn(async () => {})
      await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), consume, { maxEntryBytes: 100 }))
        .rejects.toThrow('maxEntryBytes')
      await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), consume, {}, AbortSignal.abort()))
        .rejects.toThrow()
      expect(consume).not.toHaveBeenCalled()
    })
  })

  it('cleans up when cancellation interrupts extraction before consumer publication', async () => {
    const { manifest, files } = workspaceFixture()
    await withZip(zipSync(files), async (path) => {
      const controller = new AbortController()
      // oxlint-disable-next-line typescript/unbound-method -- apply below restores the actual ZIP receiver.
      const original = ZipFile.prototype.openReadStreamPromise
      const read = vi.spyOn(ZipFile.prototype, 'openReadStreamPromise').mockImplementation(async function (this: ZipFile, ...args) {
        const stream = await original.apply(this, args)
        if (args[0].fileName.startsWith('workspace/')) stream.once('data', () => { controller.abort() })
        return stream
      })
      const consume = vi.fn(async () => {})
      try {
        await expect(withDshWorkspaceSnapshot(path, manifest, dirname(path), consume, {}, controller.signal)).rejects.toThrow()
        expect(consume).not.toHaveBeenCalled()
      } finally { read.mockRestore() }
    })
  })

  it('refuses staging without a snapshot declaration', async () => {
    await withZip(zipSync(fixture().files), async (path) => {
      const consume = vi.fn(async () => {})
      await expect(withDshWorkspaceSnapshot(path, fixture().manifest, dirname(path), consume)).rejects.toThrow('requires a valid snapshot')
      expect(consume).not.toHaveBeenCalled()
    })
  })
})


function attachmentFixture() {
  const base = fixture()
  const payloads = { 'media/large.png': new Uint8Array(2_000_000).fill(0x71), 'audit/empty.blob': new Uint8Array() }
  const manifest = completeDshArchiveManifestV1(base.manifest, [
    ...base.manifest.entries, ...Object.entries(payloads).map(([path, data]) => ({ path, kind: 'attachment' as const,
      bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })),
  ])
  return { manifest, payloads, files: { ...base.files, ...payloads, 'manifest.json': strToU8(JSON.stringify(manifest)) } }
}

describe('private archive attachment staging', () => {
  it('provides only complete attachment files, preserves empty entries and cleans up after consumption', async () => {
    const { manifest, files, payloads } = attachmentFixture()
    await withZip(zipSync(files), async (path) => {
      let staged = ''
      const result = await withDshArchiveAttachments(path, manifest, dirname(path), async (selected) => {
        expect([...selected.keys()]).toEqual(Object.keys(payloads))
        for (const [name, data] of Object.entries(payloads)) {
          staged = selected.get(name)!
          expect(await readFile(staged)).toEqual(Buffer.from(data))
          if (process.platform !== 'win32') expect((await stat(staged)).mode & 0o777).toBe(0o600)
        }
        return 'restored'
      })
      expect(result).toBe('restored')
      await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('validates the whole archive even when there are no attachments', async () => {
    const { manifest, files } = fixture()
    await withZip(zipSync(files), async (path) => {
      await withDshArchiveAttachments(path, manifest, dirname(path), async (selected) => {
        expect(selected.size).toBe(0)
      })
    })
  })

  it('never invokes the importer for corrupted unselected data or a changed manifest', async () => {
    const { manifest, files } = attachmentFixture()
    const consume = vi.fn(async () => {})
    for (const changed of [
      { ...files, 'session.jsonl': strToU8('corrupted') },
      { ...files, 'manifest.json': strToU8(JSON.stringify({ ...manifest, rootSessionId: 'different' })) },
    ]) {
      await withZip(zipSync(changed), async (path) => {
        await expect(withDshArchiveAttachments(path, manifest, dirname(path), consume)).rejects.toThrow()
      })
    }
    expect(consume).not.toHaveBeenCalled()
  })

  it('cleans up on importer failure and refuses policy violations or cancellation', async () => {
    const { manifest, files } = attachmentFixture()
    await withZip(zipSync(files), async (path) => {
      await expect(withDshArchiveAttachments(path, manifest, dirname(path), async () => { throw new Error('store failed') }))
        .rejects.toThrow('store failed')
      const consume = vi.fn(async () => {})
      await expect(withDshArchiveAttachments(path, manifest, dirname(path), consume, { maxEntryBytes: 100 }))
        .rejects.toThrow('maxEntryBytes')
      await expect(withDshArchiveAttachments(path, manifest, dirname(path), consume, {}, AbortSignal.abort()))
        .rejects.toThrow()
      expect(consume).not.toHaveBeenCalled()
    })
  })

  it('removes partial files when cancelled during decompression before importer entry', async () => {
    const { manifest, files } = attachmentFixture()
    await withZip(zipSync(files), async (path) => {
      const controller = new AbortController()
      // oxlint-disable-next-line typescript/unbound-method -- apply preserves the actual ZIP receiver.
      const original = ZipFile.prototype.openReadStreamPromise
      const read = vi.spyOn(ZipFile.prototype, 'openReadStreamPromise').mockImplementation(async function (this: ZipFile, ...args) {
        const stream = await original.apply(this, args)
        if (args[0].fileName.startsWith('media/')) stream.once('data', () => { controller.abort() })
        return stream
      })
      const consume = vi.fn(async () => {})
      try {
        await expect(withDshArchiveAttachments(path, manifest, dirname(path), consume, {}, controller.signal)).rejects.toThrow()
        expect(consume).not.toHaveBeenCalled()
      } finally { read.mockRestore() }
    })
  })
})
