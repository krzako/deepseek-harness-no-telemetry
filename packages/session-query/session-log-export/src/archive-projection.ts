/** Verify archived canonical context through its source driver's common projection port. */

import { verifyArchivedAgentContext, type AgentTransferSourcePort } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { DshArchiveBundlePreview } from './archive-bundle.ts'
import type { DshSessionArchiveManifestV1 } from './manifest.ts'
import { readDshSessionZipPayloads, type DshZipValidationPolicy } from './zip-validation.ts'

/** Reconstruct the source bundle from detached log facts and archive-only artifacts.
 * A source mismatch rejects; no target, live Session, old CODEX_HOME or local
 * attachment store participates. The caller owns private staging and deletion.
 * Artifact reads reverify the complete ZIP and buffer one artifact per read.
 * @param path - completed stable private ZIP.
 * @param manifest - inventory used to obtain the preview, rechecked on artifact reads.
 * @param preview - fully read and structurally validated archive bundle and logs.
 * @param source - registered source driver's common projection port.
 * @param policy - optional limits applied to complete ZIP reads.
 * @param signal - cancellation of reads and successful publication.
 */
export async function verifyDshSessionArchiveProjection(
  path: string,
  manifest: DshSessionArchiveManifestV1,
  preview: DshArchiveBundlePreview,
  source: AgentTransferSourcePort,
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<void> {
  const expected = structuredClone(manifest)
  await readDshSessionZipPayloads(path, expected, [], policy, signal)
  const artifact = preview.root.artifact
  // The installed format catalog already validated these current logical events.
  const session = Session.fromRestore(SessionId(artifact.header.id), artifact.events as unknown as SessionEvent[],
    artifact.header as unknown as SessionHeader, SessionLogOffset(artifact.inheritedEventCount))
  const readArtifact = async function* (sha256: string, bytes: number): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted()
    const entry = expected.entries.find(item => item.kind === 'attachment' && item.sha256 === sha256 && item.bytes === bytes)
    if (!/^[0-9a-f]{64}$/u.test(sha256) || entry === undefined) {
      throw new Error('session import: source projection requested an undeclared artifact')
    }
    const entryPath = entry.path
    const payloads = await readDshSessionZipPayloads(path, expected, [entryPath], policy, signal)
    const payload = payloads.get(entryPath)
    if (payload === undefined) throw new Error('session import: source projection artifact is missing')
    yield payload
    signal?.throwIfAborted()
  }
  signal?.throwIfAborted()
  await verifyArchivedAgentContext(source, { session, readArtifact }, preview.bundle)
  signal?.throwIfAborted()
}
