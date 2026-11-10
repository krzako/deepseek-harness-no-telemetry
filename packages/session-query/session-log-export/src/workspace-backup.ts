/** Content backups verified before an existing workspace may be replaced. */
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { captureDshWorkspaceExport } from './workspace-export.ts'
import { sameWorkspaceObservation } from './workspace-files.ts'
import { withDshNewWorkspace } from './new-workspace.ts'

/** Durable local backup metadata; copying is never a usable replacement backup. */
export interface DshWorkspaceBackupRecord {
  readonly version: 1
  readonly state: 'copying' | 'ready'
  readonly targetSessionId: string
  readonly importId: string
  readonly sourcePath: string
  readonly fingerprint: string
  readonly sourceIdentity: { readonly dev: string; readonly ino: string }
}

/** Verified content backup; no permissions, ownership or ACL restoration is implied. */
export interface DshWorkspaceBackup {
  readonly directory: string
  readonly workspacePath: string
  readonly record: DshWorkspaceBackupRecord
}

/** Backup preparation failed; the source is unchanged and partial evidence is retained. */
export class DshWorkspaceBackupError extends Error {
  /** Private directory to inspect; absence of a ready manifest forbids replacement. */
  readonly directory: string

  constructor(directory: string, cause: unknown) {
    super('workspace backup failed; backup did not modify source; inspect retained backup', { cause })
    this.name = 'DshWorkspaceBackupError'
    this.directory = directory
  }
}

function validRecord(value: unknown): value is DshWorkspaceBackupRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(',') !== 'fingerprint,importId,sourceIdentity,sourcePath,state,targetSessionId,version'
    || item.version !== 1 || item.state !== 'copying' && item.state !== 'ready'
    || !['targetSessionId', 'importId', 'sourcePath'].every(key => typeof item[key] === 'string' && item[key].length > 0)
    || !isAbsolute(item.sourcePath as string) || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(item.fingerprint)) return false
  const identity = item.sourceIdentity
  return typeof identity === 'object' && identity !== null && !Array.isArray(identity)
    && Object.keys(identity).sort().join(',') === 'dev,ino'
    && ['dev', 'ino'].every(key => typeof (identity as Record<string, unknown>)[key] === 'string'
      && /^\d+$/u.test(String((identity as Record<string, unknown>)[key])))
}

/** Copy every ordinary file and directory without modifying the authorized source.
 * The parent must be outside the source. Intent precedes copying; ready follows
 * flushed payloads, source revalidation and durable manifest publication. Failure
 * retains a private directory for inspection and never authorizes replacement.
 * Content and empty directories are preserved; permissions and ACLs are excluded.
 * @param sourcePath - existing absolute workspace selected for replacement.
 * @param parent - authorized existing directory outside that workspace.
 * @param identity - new Session and import identity owning the backup.
 * @param signal - cancellation before the ready record is published.
 * @returns complete backup location and metadata; no source files are changed.
 */
export async function createDshWorkspaceBackup(
  sourcePath: string,
  parent: string,
  identity: { readonly targetSessionId: string; readonly importId: string },
  signal?: AbortSignal,
): Promise<DshWorkspaceBackup> {
  signal?.throwIfAborted()
  if (!isAbsolute(sourcePath) || !isAbsolute(parent)) throw new Error('workspace backup: absolute paths required')
  const source = await realpath(sourcePath)
  const destinationParent = await realpath(parent)
  const fromSource = relative(source, destinationParent)
  if (fromSource === '' || !isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`)) {
    throw new Error('workspace backup: parent must be outside the source workspace')
  }
  const captured = await captureDshWorkspaceExport(sourcePath, signal)
  const before = await lstat(source, { bigint: true })
  const record: DshWorkspaceBackupRecord = { version: 1, state: 'copying', ...identity, sourcePath: source,
    fingerprint: captured.metadata.fingerprint ?? '', sourceIdentity: { dev: String(before.dev), ino: String(before.ino) } }
  if (!validRecord(record)) throw new Error('workspace backup: invalid intent')
  const directory = await mkdtemp(join(destinationParent, '.dsh-workspace-backup-'))
  const manifest = join(directory, 'backup.json')
  const workspacePath = join(directory, 'workspace')
  try {
    await writeFileAtomic(manifest, JSON.stringify(record), { mode: 0o600, durable: true })
    if (process.platform !== 'win32') {
      const parentHandle = await open(destinationParent, 'r')
      try { await parentHandle.sync() } finally { await parentHandle.close() }
    }
    return await withDshNewWorkspace(source, workspacePath, async () => {
      await captured.verify(signal)
      if (!sameWorkspaceObservation(before, await lstat(source, { bigint: true }))) throw new Error('workspace backup: source changed')
      signal?.throwIfAborted()
      const ready: DshWorkspaceBackupRecord = { ...record, state: 'ready' }
      await writeFileAtomic(manifest, JSON.stringify(ready), { mode: 0o600, durable: true })
      return { directory, workspacePath, record: ready }
    }, signal)
  } catch (error: unknown) {
    throw new DshWorkspaceBackupError(directory, error)
  }
}

/** Inspect an authorized local backup after restart without touching the source.
 * Incomplete records remain unusable. Ready records require complete content
 * verification; changed bytes, child links and malformed metadata reject.
 * @param directory - canonical private backup directory, not an uploaded archive.
 * @param signal - cancellation of inspection and content hashing.
 * @returns stored metadata and locations; only state ready permits later replacement.
 */
export async function inspectDshWorkspaceBackup(directory: string, signal?: AbortSignal): Promise<DshWorkspaceBackup> {
  signal?.throwIfAborted()
  if (await realpath(directory) !== directory) throw new Error('workspace backup: canonical directory required')
  const path = join(directory, 'backup.json')
  const before = await lstat(path, { bigint: true })
  if (!before.isFile()) throw new Error('workspace backup: regular manifest required')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let record: unknown
  try {
    if (!sameWorkspaceObservation(before, await handle.stat({ bigint: true }))) throw new Error('workspace backup: manifest changed')
    record = JSON.parse(await handle.readFile('utf8'))
    if (!sameWorkspaceObservation(before, await handle.stat({ bigint: true }))) throw new Error('workspace backup: manifest changed')
  } finally { await handle.close() }
  if (!validRecord(record)) throw new Error('workspace backup: invalid manifest')
  const workspacePath = join(directory, 'workspace')
  if (record.state === 'ready') {
    if (!(await lstat(workspacePath)).isDirectory() || await realpath(workspacePath) !== workspacePath) {
      throw new Error('workspace backup: payload directory was replaced')
    }
    const captured = await captureDshWorkspaceExport(workspacePath, signal)
    if (captured.metadata.fingerprint !== record.fingerprint) throw new Error('workspace backup: content differs from ready manifest')
    await captured.verify(signal)
  }
  if (!sameWorkspaceObservation(before, await lstat(path, { bigint: true }))) throw new Error('workspace backup: manifest changed')
  signal?.throwIfAborted()
  return { directory, workspacePath, record }
}
