/** Cross-check portable source metadata against the complete archived Session logs. */

import { isDeepStrictEqual } from 'node:util'
import { verifyCodexCheckpointArtifactV2, type CodexAuditPayloadV1 } from '@deepseek-ai/dsh-agent-codex'
import { validateDshArchiveAttachments } from './archive-attachments.ts'
import { auditArtifactRefsInEvents } from './archive.ts'
import { isAgentDriverStateV1, isPortableAgentContextV1, isPrivateDriverSnapshotV1,
  type PortableAgentBundleV1 } from '@deepseek-ai/dsh-agent'
import type { SessionFormatCatalog } from '@deepseek-ai/dsh-session-format'
import type { DshSessionArchiveManifestV1 } from './manifest.ts'
import { readDshSessionArchiveLogs, type DshArchiveLogsPreview } from './archive-logs.ts'
import { readDshSessionZipPayloads, type DshZipValidationPolicy } from './zip-validation.ts'

/** Validated source metadata and logs; this is not an import compatibility decision. */
export interface DshArchiveBundlePreview extends DshArchiveLogsPreview {
  readonly bundle: PortableAgentBundleV1
}

function parsePayload(payloads: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const bytes = payloads.get(path)
  if (bytes === undefined) throw new Error(`session import: missing metadata payload ${path}`)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch (cause) {
    throw new Error(`session import: invalid metadata JSON at ${path}`, { cause })
  }
}

/**
 * Reverify the ZIP, restore complete logs and validate canonical V1 source data.
 * Require one driver state/context, matching source identity and header lineage,
 * one durable driver selection and an optional checkpoint owned by that driver.
 * Only the private envelope is checked; its inner driver schema and destination
 * compatibility remain separate checks. Ordinary attachment references in all
 * logs and canonical items must match verified archive entries.
 * Every log audit requires ordered facts and preceding artifact receipts whose
 * SHA-256 and byte counts match the verified manifest attachments. Every logged
 * V2 checkpoint passes the Codex digest/configuration/compaction validator;
 * its artifact reads reverify the ZIP and retain one complete artifact each.
 * Metadata and logs stay resident. The caller owns private staging and deletion;
 * this reader creates no Session, thread or workspace and replays no effects.
 * @param path - completed stable private staging ZIP.
 * @param manifest - prior validated inventory, compared on every payload read.
 * @param catalog - installed Session format validation and migration catalog.
 * @param policy - optional ZIP resource limits, applied to each complete scan.
 * @param signal - read and publication cancellation.
 * @returns detached logs and canonical source bundle after all checks succeed.
 */
export async function readDshSessionArchiveBundle(
  path: string,
  manifest: DshSessionArchiveManifestV1,
  catalog: SessionFormatCatalog,
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<DshArchiveBundlePreview> {
  const expected = structuredClone(manifest)
  const logs = await readDshSessionArchiveLogs(path, expected, catalog, policy, signal)
  const entries = new Map(expected.entries.map(entry => [entry.path, entry]))
  for (const log of logs.logs) {
    const audit = auditArtifactRefsInEvents(log.artifact.events)
    for (const [sha256, ref] of audit.refs) {
      const entry = entries.get(`audit/${sha256}.blob`)
      if (entry?.kind !== 'attachment' || entry.sha256 !== sha256 || entry.bytes !== ref.bytes) {
        throw new Error(`session import: audit artifact ${sha256} disagrees with ${log.path}`)
      }
    }
    const readArtifact = async (payload: Extract<CodexAuditPayloadV1, { kind: 'artifact' }>): Promise<Uint8Array> => {
      signal?.throwIfAborted()
      const ref = audit.refs.get(payload.sha256)
      if (ref === undefined || ref.bytes !== payload.bytes) {
        throw new Error('session import: checkpoint refers to an unowned artifact')
      }
      const entryPath = `audit/${payload.sha256}.blob`
      const selected = await readDshSessionZipPayloads(path, expected, [entryPath], policy, signal)
      const bytes = selected.get(entryPath)
      if (bytes === undefined) throw new Error(`session import: missing checkpoint artifact ${entryPath}`)
      return bytes
    }
    const resolve = async (payload: CodexAuditPayloadV1): Promise<unknown> => {
      if (payload.kind === 'inline') return payload.value
      const entryPath = `audit/${payload.sha256}.blob`
      return parsePayload(new Map([[entryPath, await readArtifact(payload)]]), entryPath)
    }
    for (const { fact, preceding } of audit.checkpoints) {
      const chunks = async function* () { yield await readArtifact(fact.snapshot) }
      await verifyCodexCheckpointArtifactV2(chunks(),
        { sha256: fact.snapshot.sha256, bytes: fact.snapshot.bytes }, fact, preceding, resolve)
      signal?.throwIfAborted()
    }
  }
  for (const kind of ['driver-state', 'portable-context', 'private-snapshot'] as const) {
    const count = expected.entries.filter(entry => entry.kind === kind).length
    const required = kind === 'private-snapshot' && expected.privateSnapshotPath === null ? 0 : 1
    if (count !== required) throw new Error(`session import: ambiguous ${kind} declarations`)
  }
  const paths = [expected.driverStatePath, expected.contextPath,
    ...expected.privateSnapshotPath === null ? [] : [expected.privateSnapshotPath]]
  const payloads = await readDshSessionZipPayloads(path, expected, paths, policy, signal)
  const state = parsePayload(payloads, expected.driverStatePath)
  const context = parsePayload(payloads, expected.contextPath)
  if (!isAgentDriverStateV1(state) || !isPortableAgentContextV1(context)) {
    throw new Error('session import: invalid canonical source metadata')
  }
  if (state.sessionId !== expected.rootSessionId || !isDeepStrictEqual(state, context.source)) {
    throw new Error('session import: driver state and canonical source disagree')
  }
  const selections = logs.root.artifact.events.filter(event => event.type === 'agent/driver-selected')
  if (selections.length !== 1 || !isDeepStrictEqual(selections[0]?.data, { version: 1, driverId: state.driver.id })) {
    throw new Error('session import: durable driver selection disagrees with canonical source')
  }
  if (!isDeepStrictEqual(state.lineage, logs.root.artifact.header.importLineage)) {
    throw new Error('session import: canonical lineage disagrees with Session header')
  }
  let bundle: PortableAgentBundleV1 = { context }
  if (expected.privateSnapshotPath !== null) {
    const privateSnapshot = parsePayload(payloads, expected.privateSnapshotPath)
    if (!isPrivateDriverSnapshotV1(privateSnapshot) || privateSnapshot.driverId !== state.driver.id) {
      throw new Error('session import: invalid private checkpoint envelope or owner')
    }
    bundle = { context, privateSnapshot }
  }
  signal?.throwIfAborted()
  const preview = { ...logs, bundle }
  validateDshArchiveAttachments(preview, expected)
  return preview
}
