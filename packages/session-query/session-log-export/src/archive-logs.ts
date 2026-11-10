/** Complete, detached Session-log validation for portable archive preview. */

import type { SessionFormatArtifact, SessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { DshSessionArchiveManifestV1 } from './manifest.ts'
import { readDshSessionZipPayloads, type DshZipValidationPolicy } from './zip-validation.ts'

/** One fully decoded log; a version difference reports an in-memory migration. */
export interface DshArchiveLogPreview {
  readonly path: string
  readonly storedVersion: number
  readonly artifact: SessionFormatArtifact
}

/** Root and included descendants, without persistent Session or workspace resources. */
export interface DshArchiveLogsPreview {
  readonly root: DshArchiveLogPreview
  readonly logs: readonly DshArchiveLogPreview[]
}

function decodeLog(path: string, bytes: Uint8Array, catalog: SessionFormatCatalog): DshArchiveLogPreview {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.endsWith('\n')) throw new Error('unterminated Session log')
    const lines = text.slice(0, -1).split('\n')
    const values: unknown[] = lines.map(line => JSON.parse(line) as unknown)
    const decoded = catalog.decodeArtifact(values[0], values.slice(1))
    return { path, storedVersion: decoded.header.version, artifact: catalog.migrate(decoded) }
  } catch (cause) {
    throw new Error(`session import: invalid complete Session log at ${path}`, { cause })
  }
}

function validateTree(root: DshArchiveLogPreview, logs: readonly DshArchiveLogPreview[]): void {
  const byId = new Map<string, DshArchiveLogPreview>()
  for (const log of logs) {
    const id = log.artifact.header.id
    if (byId.has(id)) throw new Error(`session import: duplicate Session identity ${id}`)
    byId.set(id, log)
  }
  const rootHeader = root.artifact.header
  if (rootHeader.parentSession !== undefined && byId.has(rootHeader.parentSession)) {
    throw new Error('session import: root Session has a parent inside its archive')
  }
  for (const log of logs) {
    if (log === root) continue
    const header = log.artifact.header
    const parent = header.parentSession === undefined ? undefined : byId.get(header.parentSession)
    if (parent === undefined || header.delegationDepth !== parent.artifact.header.delegationDepth + 1) {
      throw new Error(`session import: invalid descendant ancestry at ${log.path}`)
    }
  }
  // Every non-root has one included parent and strictly increasing depth.
  // Finite parent chains therefore terminate at the only exempt node, root.
}

/**
 * Reverify a private ZIP and decode every manifest-declared log through the
 * installed catalog, including complete-row validation and explicit migrations.
 * Reject duplicate identities, foreign descendants, and root/workspace mismatch.
 * The caller owns stable staging and deletion; no destination is created.
 * Logs are resident in memory and operator ZIP limits apply to the full archive.
 * This does not assess canonical context, attachments, credentials or an agent.
 * @param path - completed private staging ZIP.
 * @param manifest - prior validated manifest, checked again before bytes are exposed.
 * @param catalog - installed Session codecs, migrations and current validation.
 * @param policy - optional decompressed byte and entry-count limits.
 * @param signal - cancellation of archive reads and preview publication.
 * @returns detached root and logs with stored and current versions for migration reporting.
 */
export async function readDshSessionArchiveLogs(
  path: string,
  manifest: DshSessionArchiveManifestV1,
  catalog: SessionFormatCatalog,
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<DshArchiveLogsPreview> {
  const expected = structuredClone(manifest)
  const paths = expected.entries.filter(entry => entry.kind === 'session-log').map(entry => entry.path)
  const payloads = await readDshSessionZipPayloads(path, expected, paths, policy, signal)
  const logs = [...payloads].map(([entryPath, bytes]) => {
    signal?.throwIfAborted()
    return decodeLog(entryPath, bytes, catalog)
  })
  const root = logs.find(log => log.path === expected.sessionLogPath)
  if (root === undefined || root.artifact.header.id !== expected.rootSessionId) {
    throw new Error('session import: root Session identity differs from manifest')
  }
  if ((root.artifact.header.cwd ?? null) !== expected.workspace.sourceCwd) {
    throw new Error('session import: source workspace differs from root Session header')
  }
  validateTree(root, logs)
  signal?.throwIfAborted()
  return { root, logs }
}
