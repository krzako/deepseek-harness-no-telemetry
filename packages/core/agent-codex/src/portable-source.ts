/** Read one verified Codex portable bundle from a completed durable Session. */

import type { AgentTransferSourcePort, PortableAgentBundleV1, PortableAgentStreamBundleV1, PortableCompactionV1,
  PortablePrivateSnapshotStreamV1 } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { codexPortableArtifactStream, codexPortablePayloadResolver } from './portable-artifact.ts'
import { streamVerifiedCodexCheckpointArtifactV2, verifyCodexCheckpointArtifactV2 } from './checkpoint-stream.ts'
import { projectCodexPortableBundle } from './portable-bundle.ts'
import { projectCodexCompactionAncestryStream, resolveCodexInstalledCompactions,
  resolveCodexInstalledCompactionsWithStreamedHistory } from './portable-compaction.ts'
import { verifyCodexCheckpointAuditV2 } from './context-snapshot.ts'
import { codexPortableToolOutcomes, projectCodexEffectiveHistoryStream,
  projectCodexHistoricalItemsStream } from './portable-item.ts'
import { codexPortableDriverState, selectCodexPortableSourceFacts } from './portable-source-facts.ts'

/**
 * Verify durable audit and artifact ownership before projecting one bundle.
 * The caller must supply a flushed or detached Session read and the owning
 * attachment store. A concurrent append invalidates the read. This in-memory
 * projection does not register a source port or claim bounded-memory transfer.
 * @param session - completed Codex Session behind a durable read barrier.
 * @param attachments - Session's content-addressed artifact store.
 * @returns common portable context and exact private V2 checkpoint.
 */
export async function readCodexPortableBundle(
  session: Session,
  attachments: Pick<AttachmentStore, 'readFileStream'>,
): Promise<PortableAgentBundleV1> {
  const events = session.snapshotEvents()
  const facts = selectCodexPortableSourceFacts(session)
  const resolve = codexPortablePayloadResolver(session, facts.binding.threadId, attachments)
  const rawCheckpoint = await resolve(facts.checkpoint.snapshot)
  const checkpoint = await verifyCodexCheckpointAuditV2(rawCheckpoint, facts.checkpoint, facts.preceding, resolve)
  const audits = await resolveCodexInstalledCompactions(checkpoint, facts.preceding, resolve)
  const source = codexPortableDriverState(session, facts)
  const outcomes = codexPortableToolOutcomes(session.snapshotEvents())
  const bundle = projectCodexPortableBundle(source, checkpoint, audits, outcomes)
  if (session.snapshotEvents() !== events) throw new Error('Codex portable source Session changed during read')
  return bundle
}

/** Validate a committed V2 checkpoint without retaining its JSON payload.
 * The returned second read is verified again when fully consumed by ZIP export.
 * @param session - completed, flushed or detached Codex Session.
 * @param attachments - store containing its receipt-owned checkpoint artifact.
 * @returns private V1 envelope metadata and single-use V2 context JSON bytes.
 */
export async function readCodexPortablePrivateSnapshotStream(
  session: Session,
  attachments: Pick<AttachmentStore, 'readFileStream'>,
): Promise<PortablePrivateSnapshotStreamV1> {
  const events = session.snapshotEvents()
  const facts = selectCodexPortableSourceFacts(session)
  const read = codexPortableArtifactStream(session, facts.binding.threadId, attachments)
  const resolve = codexPortablePayloadResolver(session, facts.binding.threadId, attachments)
  const artifact = facts.checkpoint.snapshot
  const runtimeRevision = await verifyCodexCheckpointArtifactV2(
    read(artifact), { sha256: artifact.sha256, bytes: artifact.bytes },
    facts.checkpoint, facts.preceding, resolve,
  )
  if (session.snapshotEvents() !== events) throw new Error('Codex portable source Session changed during read')
  return { version: 1, driverId: 'codex', driverRevision: runtimeRevision, schemaVersion: 2,
    contextJson: read(artifact), contextBytes: artifact.bytes, contextSha256: artifact.sha256 }
}

/** Project a completed Codex Session without retaining its whole checkpoint or item array.
 * The caller must consume `items` to EOF before the reference iterators, then
 * consume all ZIP entries; any append or artifact change rejects publication.
 * @param session - completed Codex Session behind a durable read barrier.
 * @param attachments - Session-owned content-addressed artifact store.
 * @returns single-use canonical context and exact private checkpoint streams.
 */
export async function readCodexPortableStreamBundle(
  session: Session,
  attachments: Pick<AttachmentStore, 'readFileStream'>,
): Promise<PortableAgentStreamBundleV1> {
  const events = session.snapshotEvents()
  const facts = selectCodexPortableSourceFacts(session)
  const source = codexPortableDriverState(session, facts)
  const outcomes = codexPortableToolOutcomes(events)
  const read = codexPortableArtifactStream(session, facts.binding.threadId, attachments)
  const resolve = codexPortablePayloadResolver(session, facts.binding.threadId, attachments)
  const artifact = facts.checkpoint.snapshot
  const runtimeRevision = await verifyCodexCheckpointArtifactV2(
    read(artifact), { sha256: artifact.sha256, bytes: artifact.bytes },
    facts.checkpoint, facts.preceding, resolve,
  )
  if (session.snapshotEvents() !== events) throw new Error('Codex portable source Session changed during read')

  const effectiveItemIds: string[] = []
  const compactions: PortableCompactionV1[] = []
  let started = false
  let completed = false
  const items = async function* () {
    if (started) throw new Error('Codex portable context items were already consumed')
    started = true
    if (session.snapshotEvents() !== events) throw new Error('Codex portable source Session changed before streaming')
    const projected = streamVerifiedCodexCheckpointArtifactV2(
      read(artifact), { sha256: artifact.sha256, bytes: artifact.bytes },
      facts.checkpoint, facts.preceding, resolve, async function* (checkpoint) {
        let activeItemCount = 0
        for await (const item of projectCodexEffectiveHistoryStream(checkpoint.array('effectiveHistory'), outcomes)) {
          effectiveItemIds.push(item.id)
          activeItemCount++
          yield item
        }
        const outputs: { readonly id: string; readonly outputItemIds: readonly string[] }[] = []
        let historicalItemCount = 0
        for await (const item of projectCodexHistoricalItemsStream(
          checkpoint.array('rollout'), checkpoint.array('compactions'), activeItemCount, outcomes,
          output => outputs.push(output),
        )) {
          historicalItemCount++
          yield item
        }
        const audits = resolveCodexInstalledCompactionsWithStreamedHistory(
          checkpoint.array('compactions'), facts.preceding, resolve, payload => resolve.historyItems(payload), (payload, prompt) => resolve.opaqueJson(payload, prompt))
        yield* projectCodexCompactionAncestryStream(audits, outputs,
          activeItemCount + historicalItemCount, outcomes, compaction => compactions.push(compaction))
      },
    )
    yield* projected
    if (session.snapshotEvents() !== events) throw new Error('Codex portable source Session changed during streaming')
    completed = true
  }
  const references = <Value>(values: readonly Value[]): AsyncIterable<Value> => {
    let consumed = false
    return {
      [Symbol.asyncIterator](): AsyncIterator<Value> {
        if (!completed) throw new Error('Codex portable context items were not fully consumed')
        if (consumed) throw new Error('Codex portable context references were already consumed')
        consumed = true
        let index = 0
        return { next: () => {
          if (session.snapshotEvents() !== events) {
            return Promise.reject(new Error('Codex portable source Session changed during references'))
          }
          const value = values[index++]
          return Promise.resolve(value === undefined
            ? { done: true, value: undefined }
            : { done: false, value })
        } }
      },
    }
  }
  const privateBytes = async function* () {
    if (session.snapshotEvents() !== events) throw new Error('Codex portable source Session changed before private bytes')
    yield* read(artifact)
    if (session.snapshotEvents() !== events) throw new Error('Codex portable source Session changed during private bytes')
  }
  return { context: { version: 1, source, items: items(),
    effectiveItemIds: references(effectiveItemIds), compactions: references(compactions) },
  privateSnapshot: { version: 1, driverId: 'codex', driverRevision: runtimeRevision, schemaVersion: 2,
    contextJson: privateBytes(), contextBytes: artifact.bytes, contextSha256: artifact.sha256 } }
}

/** Adapt durable Codex Session resolution to the shared source transfer port.
 * The caller owns flush/persistence restoration before returning a Session;
 * a mismatched or missing identity is never replaced with a live thread.
 * @param resolve - locate the completed source Session without mutating it.
 * @param attachments - session-owned attachment store for audit artifacts.
 * @returns resident import-preview and single-use streamed ZIP exporters.
 */
export function codexTransferSource(
  resolve: (sessionId: SessionId) => Session | undefined | Promise<Session | undefined>,
  attachments: Pick<AttachmentStore, 'readFileStream'>,
): AgentTransferSourcePort {
  const completed = async (sessionId: SessionId): Promise<Session> => {
    const session = await resolve(sessionId)
    if (session === undefined || session.id !== sessionId) {
      throw new Error(`Codex Session ${sessionId} is unavailable`)
    }
    return session
  }
  return {
    driverId: 'codex',
    async exportArchivedContext({ session, readArtifact }) {
      return readCodexPortableBundle(session, {
        readFileStream: ref => readArtifact(String(ref.attachmentId).replace(/^sha256:/u, ''), ref.bytes),
      })
    },
    async exportPortableContext(sessionId) {
      return readCodexPortableBundle(await completed(sessionId), attachments)
    },
    async exportPortableContextStream(sessionId) {
      return readCodexPortableStreamBundle(await completed(sessionId), attachments)
    },
  }
}
