/** Durable workspace-import intent and conservative, read-only recovery. */

import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { fingerprintDshWorkspace } from './workspace-fingerprint.ts'
import { inspectDshWorkspaceBackup } from './workspace-backup.ts'
import { sameWorkspaceObservation } from './workspace-files.ts'

/** Owned local record; no archive payload, credentials or password is stored here. */
export interface DshWorkspaceImportRecord {
  readonly version: 1
  readonly importId: string
  readonly targetSessionId: string
  readonly sourceSessionId: string
  readonly sourceDriverId: string
  readonly targetPath: string
  readonly expectedFingerprint: string
  readonly backupDirectory?: string
  readonly phase: 'intent' | 'materialized' | 'rolled-back' | 'rollback-failed'
  readonly identity: { readonly dev: string; readonly ino: string } | null
}

/** Read-only recovery observation; an unknown attempt may still have a live owner. */
export interface DshWorkspaceImportRecovery {
  readonly journalPath: string
  readonly revision: string
  readonly record: DshWorkspaceImportRecord
  readonly outcome: 'published' | 'rolled-back' | 'outcome-unknown'
  readonly sessionState: 'published' | 'not-published' | 'mismatched'
  readonly backup: {
    readonly directory: string
    readonly originalFingerprint: string | null
    readonly originalIdentityMatches: boolean
  } | null
  readonly workspace: {
    readonly exists: boolean
    readonly identityMatches: boolean
    readonly fingerprint: string | null
  }
}

function isRecord(value: unknown): value is DshWorkspaceImportRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).filter(key => key !== 'backupDirectory').sort().join(',') !== 'expectedFingerprint,identity,importId,phase,sourceDriverId,sourceSessionId,targetPath,targetSessionId,version'
    || record.version !== 1 || !['importId', 'targetSessionId', 'sourceSessionId', 'sourceDriverId', 'targetPath'].every(key => typeof record[key] === 'string' && record[key].length > 0)
    || !isAbsolute(record.targetPath as string) || typeof record.expectedFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(record.expectedFingerprint)
    || typeof record.phase !== 'string' || !['intent', 'materialized', 'rolled-back', 'rollback-failed'].includes(record.phase)) return false
  if ('backupDirectory' in record && (typeof record.backupDirectory !== 'string' || !isAbsolute(record.backupDirectory))) return false
  const identity = record.identity
  if (record.phase === 'intent' && identity !== null || record.phase === 'materialized' && identity === null) return false
  return identity === null || typeof identity === 'object' && !Array.isArray(identity)
    && Object.keys(identity).sort().join(',') === 'dev,ino'
    && ['dev', 'ino'].every(key => typeof (identity as Record<string, unknown>)[key] === 'string'
      && /^\d+$/u.test(String((identity as Record<string, unknown>)[key])))
}

/** Create a durable intent in the destination's existing parent before materialization.
 * The successful Session's durable publication is the authoritative completion record;
 * no fallible journal mutation is required after that publication commit.
 * @param input - new Session identity, authorized target and staged content fingerprint.
 * @returns journal path and durable pre-publication/failure transitions.
 */
export async function createDshWorkspaceImportJournal(
  input: Omit<DshWorkspaceImportRecord, 'version' | 'phase' | 'identity'>,
): Promise<{ path: string; record(phase: Exclude<DshWorkspaceImportRecord['phase'], 'intent'>): Promise<void> }> {
  if (!isAbsolute(input.targetPath)) throw new Error('workspace import: target path must be absolute')
  const targetPath = join(await realpath(dirname(input.targetPath)), basename(input.targetPath))
  let current: DshWorkspaceImportRecord = { ...input, targetPath, version: 1, phase: 'intent', identity: null }
  if (!isRecord(current)) throw new Error('workspace import: invalid journal intent')
  const suffix = createHash('sha256').update(input.targetSessionId).digest('hex')
  const path = join(dirname(targetPath), `.dsh-workspace-import-${suffix}.json`)
  // A fresh Session ID owns one journal; a previous reservation is never adopted.
  const reservation = await open(path, 'wx', 0o600)
  await reservation.close()
  const save = async (): Promise<void> => writeFileAtomic(path, JSON.stringify(current), { mode: 0o600, durable: true })
  await save()
  return { path, async record(phase) {
    let identity = current.identity
    if (phase === 'materialized') {
      const observed = await lstat(targetPath, { bigint: true })
      if (!observed.isDirectory() || await realpath(targetPath) !== targetPath) throw new Error('workspace import: changed destination')
      identity = { dev: String(observed.dev), ino: String(observed.ino) }
    }
    current = { ...current, phase, identity }
    await save()
  } }
}

async function readJournal(path: string): Promise<{ record: DshWorkspaceImportRecord; revision: string }> {
  const canonical = await realpath(path)
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || canonical !== path) throw new Error('workspace import: journal must be a canonical regular file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!sameWorkspaceObservation(before, await file.stat({ bigint: true }))) throw new Error('workspace import: journal changed')
    const bytes = await file.readFile()
    if (!sameWorkspaceObservation(before, await file.stat({ bigint: true }))
      || !sameWorkspaceObservation(before, await lstat(path, { bigint: true }))) throw new Error('workspace import: journal changed')
    const record: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isRecord(record)) throw new Error('workspace import: invalid recovery journal')
    return { record, revision: createHash('sha256').update(bytes).digest('hex') }
  } finally { await file.close() }
}

/** Inspect an authorized local journal and durable Session publication without changing either.
 * Absence from Session stat does not prove the absence of a hidden import or external
 * effects. Unknown records are retained and may belong to a currently active process.
 * @param journalPath - canonical path returned by journal creation or selected by the operator.
 * @param persistence - authoritative Session metadata port, not the live registry.
 * @param signal - cancellation before returning the observation.
 * @returns publication outcome and independently observed workspace fidelity.
 */
export async function inspectDshWorkspaceImport(
  journalPath: string,
  persistence: Pick<SessionPersistence, 'stat'>,
  signal?: AbortSignal,
): Promise<DshWorkspaceImportRecovery> {
  signal?.throwIfAborted()
  const { record, revision } = await readJournal(journalPath)
  const metadata = await persistence.stat(SessionId(record.targetSessionId), signal === undefined ? undefined : { signal })
  const sessionState = metadata === undefined ? 'not-published'
    : metadata.header.id === record.targetSessionId && metadata.header.cwd === record.targetPath
      && metadata.header.importLineage?.sourceSessionId === record.sourceSessionId
      && metadata.header.importLineage.sourceDriverId === record.sourceDriverId
      && metadata.header.importLineage.importId === record.importId ? 'published' : 'mismatched'
  let observed: BigIntStats | undefined
  try { observed = await lstat(record.targetPath, { bigint: true }) } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const identityMatches = observed?.isDirectory() === true && record.identity !== null
    && String(observed.dev) === record.identity.dev && String(observed.ino) === record.identity.ino
  const fingerprint = observed?.isDirectory() === true && await realpath(record.targetPath) === record.targetPath
    ? (await fingerprintDshWorkspace(record.targetPath, signal)).fingerprint : null
  let backup: DshWorkspaceImportRecovery['backup'] = null
  let originalRestored = observed === undefined
  if (record.backupDirectory !== undefined) {
    const checked = await inspectDshWorkspaceBackup(record.backupDirectory, signal)
    if (checked.record.state !== 'ready' || checked.record.targetSessionId !== record.targetSessionId
      || checked.record.importId !== record.importId || checked.record.sourcePath !== record.targetPath) {
      throw new Error('workspace import: recovery backup does not match intent')
    }
    const originalPath = join(record.backupDirectory, 'original')
    let originalStat: BigIntStats | undefined
    try { originalStat = await lstat(originalPath, { bigint: true }) } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const originalFingerprint = originalStat?.isDirectory() === true && await realpath(originalPath) === originalPath
      ? (await fingerprintDshWorkspace(originalPath, signal)).fingerprint : null
    backup = { directory: record.backupDirectory, originalFingerprint,
      originalIdentityMatches: originalStat?.isDirectory() === true
        && String(originalStat.dev) === checked.record.sourceIdentity.dev
        && String(originalStat.ino) === checked.record.sourceIdentity.ino }
    originalRestored = observed?.isDirectory() === true && String(observed.dev) === checked.record.sourceIdentity.dev
      && String(observed.ino) === checked.record.sourceIdentity.ino && fingerprint === checked.record.fingerprint
  }
  const outcome = sessionState === 'published' ? 'published'
    : record.phase === 'rolled-back' && originalRestored && sessionState === 'not-published' ? 'rolled-back' : 'outcome-unknown'
  if ((await readJournal(journalPath)).revision !== revision) throw new Error('workspace import: journal changed during recovery inspection')
  signal?.throwIfAborted()
  return { journalPath, revision, record, outcome, sessionState, backup,
    workspace: { exists: observed !== undefined, identityMatches, fingerprint } }
}

/** Recheck a recovery observation and explicitly retain every workspace and audit byte.
 * This performs no cleanup, resume or historical replay and grants no write permission.
 * @param expected - operator-reviewed observation; changes require another inspection.
 * @param persistence - authoritative durable Session metadata port.
 * @param signal - cancellation of the repeat inspection.
 * @returns the unchanged outcome after retaining all data.
 */
export async function retainDshWorkspaceImport(
  expected: DshWorkspaceImportRecovery,
  persistence: Pick<SessionPersistence, 'stat'>,
  signal?: AbortSignal,
): Promise<DshWorkspaceImportRecovery['outcome']> {
  const current = await inspectDshWorkspaceImport(expected.journalPath, persistence, signal)
  if (!isDeepStrictEqual(expected, current)) throw new Error('workspace import: recovery observation changed; inspect again')
  return current.outcome
}
