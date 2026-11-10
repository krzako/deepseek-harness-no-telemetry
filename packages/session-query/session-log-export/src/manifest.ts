/** Manifest for the portable DSH Session ZIP; explicit transcript-only downloads have none. */

import type { DshWorkspaceFingerprintUnavailable } from './workspace-fingerprint.ts'

/** Archive manifest version independent of Session JSONL generation. */
export const DSH_SESSION_ARCHIVE_VERSION = 1 as const

/** Every payload is addressed by a relative ZIP path and verified before import. */
export interface DshArchiveEntryV1 {
  readonly path: string
  readonly kind: 'session-log' | 'portable-context' | 'driver-state' | 'private-snapshot' | 'attachment' | 'workspace'
  readonly bytes: number
  readonly sha256: string
}

/** Workspace fingerprint is descriptive; applying a snapshot remains a separate user choice. */
export interface DshArchiveWorkspaceV1 {
  readonly sourceCwd: string | null
  readonly fingerprint: string | null
  /** Absent in legacy manifests, whose digest cannot establish content equality. */
  readonly fingerprintAlgorithm?: 'dsh-workspace-content-v1'
  /** Explicit reason for a null fingerprint in newly exported manifests. */
  readonly fingerprintUnavailable?: DshWorkspaceFingerprintUnavailable
  readonly snapshot: {
    readonly prefix: string
    readonly complete: boolean
    /** Complete directory inventory beneath prefix, using archive paths; root is implicit.
     * Absent in older snapshots, which cannot reconstruct empty directories.
     */
    readonly directories?: readonly string[]
  } | null
}

/** Index of one portable session and its optional namespaced driver checkpoint. */
export interface DshSessionArchiveManifestV1 {
  readonly version: typeof DSH_SESSION_ARCHIVE_VERSION
  readonly rootSessionId: string
  readonly sessionLogPath: string
  readonly driverStatePath: string
  readonly contextPath: string
  readonly privateSnapshotPath: string | null
  readonly entries: readonly DshArchiveEntryV1[]
  readonly workspace: DshArchiveWorkspaceV1
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key))
}

/** Test a normalized relative archive payload path without filesystem access.
 * @param value - untrusted ZIP or manifest path.
 * @returns whether the path has no absolute, traversal, separator or control-character ambiguity.
 */
export function isDshArchivePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/')
    && !value.includes('\\') && !/[\u0000-\u001f\u007f:]/u.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isEntry(value: unknown): value is DshArchiveEntryV1 {
  return record(value) && exact(value, ['path', 'kind', 'bytes', 'sha256']) && isDshArchivePath(value.path)
    && typeof value.kind === 'string'
    && ['session-log', 'portable-context', 'driver-state', 'private-snapshot', 'attachment', 'workspace'].includes(value.kind)
    && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && digest(value.sha256)
}

/**
 * Reject malformed paths, duplicate entries, missing required payloads, and inconsistent snapshot declarations.
 * This schema check does not read ZIP payloads or verify their SHA-256 hashes.
 * @param value - parsed archive manifest.
 * @returns whether its fields and internal references are valid.
 */
export function isDshSessionArchiveManifestV1(value: unknown): value is DshSessionArchiveManifestV1 {
  if (!record(value) || !exact(value, ['version', 'rootSessionId', 'sessionLogPath', 'driverStatePath', 'contextPath', 'privateSnapshotPath', 'entries', 'workspace'])
    || value.version !== DSH_SESSION_ARCHIVE_VERSION || typeof value.rootSessionId !== 'string' || value.rootSessionId.length === 0
    || !isDshArchivePath(value.sessionLogPath) || !isDshArchivePath(value.driverStatePath) || !isDshArchivePath(value.contextPath)
    || (value.privateSnapshotPath !== null && !isDshArchivePath(value.privateSnapshotPath))
    || !Array.isArray(value.entries) || !value.entries.every(isEntry)) return false
  const entries = value.entries
  const paths = new Set(entries.map(entry => entry.path))
  if (paths.size !== entries.length || paths.has('manifest.json')) return false
  const has = (path: string, kind: DshArchiveEntryV1['kind']): boolean => entries.some(entry => entry.path === path && entry.kind === kind)
  if (!has(value.sessionLogPath, 'session-log') || !has(value.driverStatePath, 'driver-state')
    || !has(value.contextPath, 'portable-context')
    || (value.privateSnapshotPath !== null && !has(value.privateSnapshotPath, 'private-snapshot'))
    || (value.privateSnapshotPath === null && entries.some(entry => entry.kind === 'private-snapshot'))) return false
  const workspace = value.workspace
  if (!record(workspace) || !['sourceCwd', 'fingerprint', 'snapshot'].every(key => Object.hasOwn(workspace, key))
    || Object.keys(workspace).some(key => !['sourceCwd', 'fingerprint', 'snapshot', 'fingerprintAlgorithm', 'fingerprintUnavailable'].includes(key))
    || (workspace.sourceCwd !== null && (typeof workspace.sourceCwd !== 'string' || workspace.sourceCwd.length === 0))
    || (workspace.fingerprint !== null && !digest(workspace.fingerprint))) return false
  if (Object.hasOwn(workspace, 'fingerprintAlgorithm') && (workspace.fingerprintAlgorithm !== 'dsh-workspace-content-v1'
    || workspace.fingerprint === null || Object.hasOwn(workspace, 'fingerprintUnavailable'))) return false
  if (Object.hasOwn(workspace, 'fingerprintUnavailable') && (workspace.fingerprint !== null
    || typeof workspace.fingerprintUnavailable !== 'string'
    || !['not-selected', 'invalid-path', 'missing', 'not-directory', 'unreadable', 'unsupported'].includes(workspace.fingerprintUnavailable))) return false
  if (workspace.snapshot === null) return !entries.some(entry => entry.kind === 'workspace')
  const snapshot = workspace.snapshot
  if (!record(snapshot) || !['prefix', 'complete'].every(key => Object.hasOwn(snapshot, key))
    || Object.keys(snapshot).some(key => !['prefix', 'complete', 'directories'].includes(key)) || !isDshArchivePath(snapshot.prefix)
    || snapshot.complete !== true) return false
  const prefix = snapshot.prefix
  const workspacePaths = entries.filter(entry => entry.kind === 'workspace').map(entry => entry.path)
  if (!workspacePaths.every(path => path.startsWith(`${prefix}/`))) return false
  if (!Object.hasOwn(snapshot, 'directories')) return true
  if (!Array.isArray(snapshot.directories)) return false
  const directoryPaths: unknown[] = snapshot.directories
  if (!directoryPaths.every(isDshArchivePath)) return false
  const directories = new Set(directoryPaths)
  if (directories.size !== directoryPaths.length || paths.has(prefix)
    || directoryPaths.some(path => !path.startsWith(`${prefix}/`) || paths.has(path))) return false
  for (const path of [...workspacePaths, ...directoryPaths]) {
    let parent = path.slice(0, path.lastIndexOf('/'))
    while (parent !== prefix) {
      if (!directories.has(parent)) return false
      parent = parent.slice(0, parent.lastIndexOf('/'))
    }
  }
  return true
}

/**
 * Verify a parsed manifest against every fully consumed payload, excluding
 * manifest.json itself. Receipts must come from measured uncompressed bytes,
 * never from ZIP headers or the manifest's own declarations. The caller owns
 * container validation, decompression limits, and semantic payload validation.
 * @param value - untrusted parsed manifest.
 * @param receipts - complete payload inventory, including duplicate names if present.
 * @returns the manifest after exact inventory, byte-count, and SHA-256 agreement.
 * @throws if the manifest is invalid or any payload is missing, extra, repeated, or changed.
 */
export function verifyDshArchiveInventory(
  value: unknown,
  receipts: Iterable<Pick<DshArchiveEntryV1, 'path' | 'bytes' | 'sha256'>>,
): DshSessionArchiveManifestV1 {
  if (!isDshSessionArchiveManifestV1(value)) throw new Error('session import: invalid archive manifest')
  const declared = new Map(value.entries.map(entry => [entry.path, entry]))
  const seen = new Set<string>()
  for (const receipt of receipts) {
    if (seen.has(receipt.path)) throw new Error(`session import: duplicate archive payload ${receipt.path}`)
    const entry = declared.get(receipt.path)
    if (entry === undefined) throw new Error(`session import: undeclared archive payload ${receipt.path}`)
    if (receipt.bytes !== entry.bytes || receipt.sha256 !== entry.sha256) {
      throw new Error(`session import: archive payload hash or size differs at ${receipt.path}`)
    }
    seen.add(receipt.path)
  }
  for (const path of declared.keys()) {
    if (!seen.has(path)) throw new Error(`session import: missing archive payload ${path}`)
  }
  return value
}
