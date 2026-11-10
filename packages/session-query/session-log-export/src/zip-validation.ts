/** Portable ZIP validation and private staging before session or workspace publication. */

import { createHash } from 'node:crypto'
import { fingerprintDshWorkspace } from './workspace-fingerprint.ts'
import { on } from 'node:events'
import { addAbortSignal } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { crc32 } from 'node:zlib'
import { mkdir, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openPromise, type Entry } from 'yauzl'
import { isDshSessionArchiveManifestV1, isDshArchivePath, verifyDshArchiveInventory, type DshSessionArchiveManifestV1 } from './manifest.ts'
import { createDshArchiveResourceBudget, type DshArchiveResourcePolicy } from './manifest-stream.ts'

/** A log-only or legacy ZIP cannot establish a portable agent context. */
export class DshArchiveManifestRequiredError extends Error {
  /** Stable reason for refusing faithful import of a transcript-only archive. */
  readonly code = 'DSH_ARCHIVE_MANIFEST_REQUIRED'

  constructor() {
    super('session import: this archive has no portable manifest; log-only or legacy archives cannot faithfully restore agent context. Export a portable Session archive from the source instance.')
    this.name = 'DshArchiveManifestRequiredError'
  }
}

/** Private staging could not be removed; completed consumer effects remain in force. */
export class DshArchiveStagingCleanupError extends Error {
  /** Private staging location requiring authorized inspection; partial cleanup may have removed some entries. */
  readonly stagingPath: string

  constructor(stagingPath: string, cause: unknown) {
    super('session import: private staging cleanup failed; inspect retained staging', { cause })
    this.name = 'DshArchiveStagingCleanupError'
    this.stagingPath = stagingPath
  }
}

/** Operator-selected bounds; omitted limits impose no fixed archive-size ceiling. */
export interface DshZipValidationPolicy extends DshArchiveResourcePolicy {
  /** Maximum central-directory entries, including directories and the manifest. */
  readonly maxEntries?: number
}

function admitName(entry: Entry, files: Set<string>, directories: Set<string>): boolean {
  const directory = entry.fileName.endsWith('/')
  const path = directory ? entry.fileName.slice(0, -1) : entry.fileName
  if (!isDshArchivePath(path)) throw new Error('session import: unsafe ZIP path')
  const mode = entry.externalFileAttributes >>> 16 & 0xf000
  if (mode !== 0 && mode !== (directory ? 0x4000 : 0x8000)) {
    throw new Error(`session import: non-regular ZIP entry ${path}`)
  }
  if (files.has(path) || directories.has(path) && !directory) {
    throw new Error(`session import: duplicate or conflicting ZIP path ${path}`)
  }
  const segments = path.split('/')
  for (let index = 1; index < segments.length; index++) {
    const parent = segments.slice(0, index).join('/')
    if (files.has(parent)) throw new Error(`session import: conflicting ZIP parent ${parent}`)
    directories.add(parent)
  }
  if (directory) directories.add(path)
  else files.add(path)
  return directory
}

/** Verify a portable ZIP's complete inventory without extracting or publishing anything.
 * The caller supplies a stable private file and owns its deletion. This operation
 * closes its file and entry readers on success, error or cancellation. It retains
 * the manifest and path/receipt sets; payload bytes are measured incrementally.
 * Directories may describe structure but must be empty. Only stored and deflated
 * regular files are accepted; encrypted ZIP entries are not the age envelope.
 * @param path - private, completed upload or decrypted staging file.
 * @param policy - optional uncompressed byte and entry-count limits, including the manifest.
 * @param signal - cancellation for directory iteration and decompression.
 * @returns manifest verified against measured SHA-256, CRC32 and sizes of all payloads.
 * @throws DshArchiveManifestRequiredError for a ZIP without a portable manifest;
 * otherwise for invalid ZIP metadata, paths, receipts, resource overruns or cancellation.
 */
export async function validateDshSessionZip(
  path: string,
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<DshSessionArchiveManifestV1> {
  return scanDshSessionZip(path, policy, signal)
}

/** Read selected payloads only after revalidating the whole ZIP against a prior manifest.
 * No data escapes on partial consumption, corruption or cancellation. The caller
 * owns the stable private staging file; this operation closes its readers but
 * does not delete or extract it. Selected payloads are resident in memory, while
 * all other payloads are measured without buffering.
 * @param path - completed private staging file used for the prior validation.
 * @param manifest - manifest returned by validateDshSessionZip for that file.
 * @param payloadPaths - unique payload paths declared by that manifest.
 * @param policy - optional limits for all decompressed bytes and entries, not just selected data.
 * @param signal - cancellation of directory and payload reads.
 * @returns complete selected payload bytes after full inventory and manifest verification.
 */
export async function readDshSessionZipPayloads(
  path: string,
  manifest: DshSessionArchiveManifestV1,
  payloadPaths: readonly string[],
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const expected = structuredClone(manifest)
  if (!isDshSessionArchiveManifestV1(expected)) throw new Error('session import: invalid preview manifest')
  const selected = new Set(payloadPaths)
  const declared = new Set(expected.entries.map(entry => entry.path))
  if (selected.size !== payloadPaths.length || [...selected].some(name => !declared.has(name))) {
    throw new Error('session import: selected payload paths are duplicate or absent from manifest')
  }
  const chunks = new Map([...selected].map(name => [name, [] as Uint8Array[]]))
  const actual = await scanDshSessionZip(path, policy, signal, (name, chunk) => {
    chunks.get(name)?.push(Buffer.from(chunk))
  })
  if (!isDeepStrictEqual(actual, expected)) throw new Error('session import: archive manifest changed since validation')
  signal?.throwIfAborted()
  return new Map([...chunks].map(([name, parts]) => [name, Buffer.concat(parts)]))
}

/** Materialize verified snapshot bytes for one consumer, then remove private staging.
 * The destination workspace is never touched. Files use exclusive owner-only
 * creation under a fresh private directory; payloads stream with backpressure.
 * The consumer runs only after the whole ZIP and captured manifest agree, including
 * non-workspace entries. It may move the completed contents during its own import
 * transaction; it must not retain the staging path after returning. Errors and
 * cancellation remove partial files and close handles before rejection.
 * Publication and cancellation after consumer entry belong to that consumer.
 * Declared directories include empty ones; older snapshots without their inventory
 * reconstruct only file parents. A recognized fingerprint is verified when directories
 * are recorded. Source permissions are not reconstructed.
 * @param path - completed private archive file.
 * @param manifest - fully validated preview manifest with a workspace snapshot.
 * @param stagingParent - authorized existing directory for private staging.
 * @param consume - operation receiving the complete verified snapshot directory.
 * @param policy - optional limits for all ZIP entries, including non-workspace data.
 * @param signal - cancellation of extraction and publication to the consumer.
 * Cleanup failure throws DshArchiveStagingCleanupError after a successful consumer;
 * it does not undo consumer effects. Combined failures preserve both causes.
 * @returns the consumer's result after staging cleanup.
 */
export async function withDshWorkspaceSnapshot<T>(
  path: string,
  manifest: DshSessionArchiveManifestV1,
  stagingParent: string,
  consume: (directory: string) => Promise<T>,
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<T> {
  const expected = structuredClone(manifest)
  if (!isDshSessionArchiveManifestV1(expected) || expected.workspace.snapshot === null) {
    throw new Error('session import: workspace staging requires a valid snapshot manifest')
  }
  const prefix = `${expected.workspace.snapshot.prefix}/`
  const directories = expected.workspace.snapshot.directories ?? []
  return withStagedPayloads(path, expected, stagingParent, '.dsh-workspace-',
    entry => entry.kind === 'workspace' ? entry.path.slice(prefix.length) : undefined,
    async (directory) => {
      for (const path of directories) {
        signal?.throwIfAborted()
        await mkdir(join(directory, path.slice(prefix.length)), { recursive: true, mode: 0o700 })
      }
      if (expected.workspace.snapshot?.directories !== undefined
        && expected.workspace.fingerprintAlgorithm === 'dsh-workspace-content-v1') {
        const restored = await fingerprintDshWorkspace(directory, signal)
        if (restored.fingerprint !== expected.workspace.fingerprint) throw new Error('session import: snapshot fingerprint differs')
      }
      signal?.throwIfAborted()
      return consume(directory)
    }, policy, signal)
}

/** Stream all archived attachments to private files before invoking their importer.
 * Every ZIP entry is revalidated against the captured manifest before any path is
 * exposed. Map keys are archive paths; values are completed private files, including
 * empty files. The importer owns publication to attachment/audit stores, while this
 * operation always removes staging afterward. No Session or workspace is published.
 * Files must not be retained after the consumer returns. Payload memory is bounded
 * by decompressor chunks and sequential awaited writes; inventory remains resident.
 * @param path - completed stable private archive.
 * @param manifest - previously validated inventory.
 * @param stagingParent - authorized existing directory for private staging.
 * @param consume - importer of verified staged bytes; owns cancellation after entry.
 * @param policy - optional limits applied to the whole archive.
 * @param signal - cancellation before consumer entry.
 * Cleanup failure does not undo stored attachments; combined failures retain both causes.
 * @returns consumer result after staging cleanup.
 */
export async function withDshArchiveAttachments<T>(
  path: string,
  manifest: DshSessionArchiveManifestV1,
  stagingParent: string,
  consume: (files: ReadonlyMap<string, string>) => Promise<T>,
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<T> {
  const expected = structuredClone(manifest)
  if (!isDshSessionArchiveManifestV1(expected)) throw new Error('session import: invalid attachment staging manifest')
  return withStagedPayloads(path, expected, stagingParent, '.dsh-attachments-',
    entry => entry.kind === 'attachment' ? entry.path : undefined,
    async (_directory, files) => consume(files), policy, signal)
}

async function withStagedPayloads<T>(
  path: string,
  expected: DshSessionArchiveManifestV1,
  stagingParent: string,
  stagingPrefix: string,
  relativePath: (entry: DshSessionArchiveManifestV1['entries'][number]) => string | undefined,
  consume: (directory: string, files: ReadonlyMap<string, string>) => Promise<T>,
  policy: DshZipValidationPolicy,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const staging = await mkdtemp(join(stagingParent, stagingPrefix))
  let handle: FileHandle | undefined
  let failure: { error: unknown } | undefined
  try {
    const directory = join(staging, 'payloads')
    await mkdir(directory, { mode: 0o700 })
    const selected = new Map<string, string>()
    for (const entry of expected.entries) {
      const relative = relativePath(entry)
      if (relative === undefined) continue
      signal?.throwIfAborted()
      const destination = join(directory, relative)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      const empty = await open(destination, 'wx', 0o600)
      await empty.close()
      selected.set(entry.path, destination)
    }
    let current: string | undefined
    const actual = await scanDshSessionZip(path, policy, signal, async (name, chunk) => {
      const destination = selected.get(name)
      if (destination === undefined) return
      if (handle === undefined || current !== name) {
        await handle?.close()
        handle = undefined
        handle = await open(destination, 'r+')
        current = name
      }
      // writeFile advances the open descriptor and handles partial writes.
      await handle.writeFile(chunk)
    })
    await handle?.close()
    handle = undefined
    if (!isDeepStrictEqual(actual, expected)) throw new Error('session import: archive manifest changed since validation')
    signal?.throwIfAborted()
    return await consume(directory, selected)
  } catch (error: unknown) {
    failure = { error }
    throw error
  } finally {
    const errors: unknown[] = []
    try { await handle?.close() } catch (error: unknown) { errors.push(error) }
    try { await rm(staging, { recursive: true, force: true }) } catch (error: unknown) { errors.push(error) }
    if (errors.length > 0) {
      const cleanup = new DshArchiveStagingCleanupError(staging, new AggregateError(errors, 'staging cleanup errors'))
      if (failure !== undefined) throw new AggregateError([failure.error, cleanup], 'session import failed and staging cleanup failed', { cause: failure.error })
      throw cleanup
    }
  }
}

async function scanDshSessionZip(
  path: string,
  policy: DshZipValidationPolicy,
  signal?: AbortSignal,
  onPayloadChunk?: (path: string, chunk: Uint8Array) => void | Promise<void>,
): Promise<DshSessionArchiveManifestV1> {
  const budget = createDshArchiveResourceBudget(policy)
  if (policy.maxEntries !== undefined && (!Number.isSafeInteger(policy.maxEntries) || policy.maxEntries < 1)) {
    throw new RangeError('session import: maxEntries must be a positive safe integer')
  }
  signal?.throwIfAborted()
  const zip = await openPromise(path, { autoClose: false, lazyEntries: true,
    strictFileNames: true, validateEntrySizes: true })
  const closed = new Promise<void>((resolve) => { zip.once('close', resolve) })
  let zipError: Error | undefined
  const observeError = (error: Error): void => { zipError = error }
  zip.on('error', observeError)
  try {
    signal?.throwIfAborted()
    if (policy.maxEntries !== undefined && zip.entryCount > policy.maxEntries) {
      throw new Error('session import: ZIP exceeds configured maxEntries')
    }
    const files = new Set<string>()
    const directories = new Set<string>()
    const explicitDirectories = new Set<string>()
    const receipts: { path: string; bytes: number; sha256: string }[] = []
    let manifest: unknown
    const entries = on(zip, 'entry', { close: ['end'], ...signal === undefined ? {} : { signal } })
    zip.readEntry()
    for await (const args of entries) {
      const entry = args[0] as Entry
      const directory = admitName(entry, files, directories)
      if (directory && explicitDirectories.has(entry.fileName)) throw new Error('session import: duplicate ZIP directory')
      if (directory) explicitDirectories.add(entry.fileName)
      if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 0x40) !== 0) {
        throw new Error('session import: encrypted ZIP entries are unsupported; use the age envelope')
      }
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new Error('session import: unsupported ZIP compression')
      const header = await zip.readLocalFileHeaderPromise(entry)
      if (header.generalPurposeBitFlag !== entry.generalPurposeBitFlag || header.compressionMethod !== entry.compressionMethod
        || !header.fileName.equals(entry.fileNameRaw)) throw new Error('session import: local and central ZIP headers differ')
      if ((entry.generalPurposeBitFlag & 8) === 0 && (header.crc32 !== entry.crc32
        || header.compressedSize !== 0xffffffff && header.compressedSize !== entry.compressedSize
        || header.uncompressedSize !== 0xffffffff && header.uncompressedSize !== entry.uncompressedSize)) {
        throw new Error('session import: local and central ZIP sizes or CRC differ')
      }
      const stream = await zip.openReadStreamPromise(entry)
      if (signal !== undefined) addAbortSignal(signal, stream)
      const hash = createHash('sha256')
      const manifestChunks: Uint8Array[] = []
      let bytes = 0
      let crc = 0
      for await (const raw of stream) {
        const chunk = raw as Buffer
        bytes += chunk.length
        budget.accept(entry.fileName, bytes, chunk.length)
        if (directory && bytes !== 0) throw new Error('session import: ZIP directory contains data')
        hash.update(chunk)
        crc = crc32(chunk, crc)
        if (entry.fileName === 'manifest.json') manifestChunks.push(chunk)
        else if (!directory) await onPayloadChunk?.(entry.fileName, chunk)
      }
      if (bytes !== entry.uncompressedSize || crc !== entry.crc32) throw new Error('session import: ZIP CRC or size differs')
      if (entry.fileName === 'manifest.json') {
        manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(manifestChunks))) as unknown
      } else if (!directory) receipts.push({ path: entry.fileName, bytes, sha256: hash.digest('hex') })
      signal?.throwIfAborted()
      zip.readEntry()
    }
    if (!files.has('manifest.json')) throw new DshArchiveManifestRequiredError()
    return verifyDshArchiveInventory(manifest, receipts)
  } finally {
    zip.close()
    await closed
    zip.off('error', observeError)
    if (zipError !== undefined) throw zipError
  }
}
