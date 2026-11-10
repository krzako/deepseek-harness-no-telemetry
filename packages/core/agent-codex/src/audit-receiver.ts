/** Durable, sequenced admission of Codex-owned facts into one DSH Session. */

import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { AttachmentId, type AttachmentStore, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Session } from '@deepseek-ai/dsh-session'
import { parseCodexAuditEventV1, type CodexAuditEventV1, type CodexAuditPayloadV1 } from './audit-contract.ts'
import { verifyCodexCheckpointArtifactV2 } from './checkpoint-stream.ts'
import type {} from './types.ts'

interface AuditCursor {
  readonly version: 1
  readonly sequence: number
  readonly eventId: string | null
}

export interface CodexAuditArtifactReceipt {
  readonly version: 1
  readonly threadId: string
  readonly sha256: string
  readonly bytes: number
  readonly mediaType: string
  readonly name: string
}

// Persisted receipts retain a version check even when the current Session type only declares V1.
function isValidArtifactReceipt(
  receipt: Omit<CodexAuditArtifactReceipt, 'version'> & { readonly version: unknown },
  threadId: string,
): receipt is CodexAuditArtifactReceipt {
  return receipt.version === 1 && receipt.threadId === threadId
    && /^[a-f0-9]{64}$/.test(receipt.sha256)
    && Number.isSafeInteger(receipt.bytes) && receipt.bytes >= 0
    && /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(receipt.mediaType)
    && receipt.name === `dsh-audit-${receipt.sha256}.blob`
}

type PendingCompaction = Extract<CodexAuditEventV1, { readonly kind: 'compaction/pending' }>
const PAYLOAD_FIELDS = [
  'request', 'chunk', 'result', 'arguments', 'inputHistory', 'prompt',
  'effectiveHistory', 'details', 'config', 'response', 'snapshot',
] as const

function nextPendingCompaction(pending: PendingCompaction | undefined, event: CodexAuditEventV1): PendingCompaction | undefined {
  if (pending !== undefined) {
    if (event.kind === 'compaction/aborted' && pending.priorRolloutSha256 === undefined) {
      throw new Error(`agent-codex: compaction ${pending.compactionId} has no prior rollout anchor`)
    }
    if ((event.kind !== 'compaction/installed' && event.kind !== 'compaction/aborted')
      || event.compactionId !== pending.compactionId
      || !isDeepStrictEqual(event.effectiveHistory, pending.effectiveHistory)) {
      throw new Error(`agent-codex: compaction ${pending.compactionId} is pending installation`)
    }
    return undefined
  }
  if (event.kind === 'compaction/installed' || event.kind === 'compaction/aborted') {
    throw new Error(`agent-codex: compaction ${event.compactionId} has no pending checkpoint`)
  }
  return event.kind === 'compaction/pending' ? event : undefined
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** Serializes fork requests and acknowledges only facts covered by a successful Session flush. */
export class CodexAuditReceiver {
  private readonly facts = new Map<number, CodexAuditEventV1>()
  private readonly eventIds = new Map<string, number>()
  private sequence = 0
  private tail: Promise<void> = Promise.resolve()
  private failure: Error | undefined
  private pendingCompaction: PendingCompaction | undefined
  private readonly artifacts = new Map<string, CodexAuditArtifactReceipt>()

  constructor(
    private readonly session: Session,
    private readonly threadId: string,
    private readonly flush: () => Promise<boolean>,
    private readonly onFailure: (error: Error) => void,
    private readonly attachments?: AttachmentStore,
  ) {
    for (const entry of session.snapshotEvents()) {
      if (entry.type === 'codex/artifact-v1') {
        const artifact = entry.data
        if (!isValidArtifactReceipt(artifact, threadId) || this.artifacts.has(artifact.sha256)) {
          throw new Error('agent-codex: persisted audit artifact receipt is invalid or duplicated')
        }
        this.artifacts.set(artifact.sha256, artifact)
        continue
      }
      if (entry.type !== 'codex/audit-v1') continue
      const event = parseCodexAuditEventV1(entry.data)
      if (event.threadId !== threadId || event.sequence !== this.sequence + 1
        || this.eventIds.has(event.eventId)) {
        throw new Error('agent-codex: persisted audit stream has a thread, sequence, or eventId conflict')
      }
      this.pendingCompaction = nextPendingCompaction(this.pendingCompaction, event)
      this.facts.set(event.sequence, event)
      this.eventIds.set(event.eventId, event.sequence)
      this.sequence = event.sequence
    }
  }

  /** Commit artifact ownership only after its bytes are durably stored. */
  commitArtifact(receipt: CodexAuditArtifactReceipt): Promise<CodexAuditArtifactReceipt> {
    return this.enqueue(async () => {
      if (!isValidArtifactReceipt(receipt, this.threadId)) {
        throw new Error('agent-codex: invalid audit artifact receipt')
      }
      const prior = this.artifacts.get(receipt.sha256)
      if (prior !== undefined) {
        if (!isDeepStrictEqual(prior, receipt)) throw new Error('agent-codex: audit artifact receipt conflict')
        return prior
      }
      this.session.append('codex/artifact-v1', receipt)
      if (!await this.flush()) throw new Error('agent-codex: durable audit artifact storage is unavailable')
      this.artifacts.set(receipt.sha256, receipt)
      return receipt
    })
  }

  artifact(sha256: string): CodexAuditArtifactReceipt | undefined {
    return this.artifacts.get(sha256)
  }

  /** Return the last flushed fact after all preceding appends have settled. */
  cursor(): Promise<AuditCursor> {
    return this.enqueue(() => this.currentCursor())
  }

  /** Reject gaps and conflicts; identical retries return the original durable ACK. */
  append(value: unknown): Promise<AuditCursor> {
    return this.enqueue(async () => {
      const event = parseCodexAuditEventV1(value)
      if (event.threadId !== this.threadId) {
        throw new Error('agent-codex: audit event referenced another thread')
      }
      const prior = this.facts.get(event.sequence)
      if (prior !== undefined) {
        if (isDeepStrictEqual(prior, event)) {
          return { version: 1, sequence: event.sequence, eventId: event.eventId }
        }
        throw new Error('agent-codex: repeated audit sequence changed its payload')
      }
      if (event.sequence !== this.sequence + 1) {
        throw new Error(`agent-codex: audit sequence gap; expected ${this.sequence + 1}, got ${event.sequence}`)
      }
      if (this.eventIds.has(event.eventId)) {
        throw new Error('agent-codex: audit eventId reused at another sequence')
      }
      const pendingCompaction = nextPendingCompaction(this.pendingCompaction, event)
      await this.verifyArtifactReferences(event)
      if (event.kind === 'checkpoint') {
        const receipt = this.artifacts.get(event.snapshot.sha256)
        if (receipt === undefined || this.attachments === undefined) {
          throw new Error('agent-codex: checkpoint artifact is unavailable')
        }
        const file: FileAttachmentRef = {
          attachmentId: AttachmentId(`sha256:${receipt.sha256}`), name: receipt.name, bytes: receipt.bytes,
        }
        await verifyCodexCheckpointArtifactV2(this.attachments.readFileStream(file), receipt,
          event, [...this.facts.values()], payload => this.resolvePayload(payload))
      }
      this.session.append('codex/audit-v1', event)
      if (!await this.flush()) {
        throw new Error('agent-codex: durable Session audit storage is unavailable')
      }
      this.facts.set(event.sequence, event)
      this.eventIds.set(event.eventId, event.sequence)
      this.sequence = event.sequence
      this.pendingCompaction = pendingCompaction
      return this.currentCursor()
    })
  }

  private async verifyArtifactReferences(event: CodexAuditEventV1): Promise<void> {
    const fields = event as Record<string, unknown>
    for (const field of PAYLOAD_FIELDS) {
      const payload = fields[field]
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue
      const reference = payload as Record<string, unknown>
      if (reference.kind !== 'artifact') continue
      const sha256 = reference.sha256 as string
      const bytes = reference.bytes as number
      const mediaType = reference.mediaType as string
      const receipt = this.artifacts.get(sha256)
      if (receipt === undefined || receipt.bytes !== bytes || receipt.mediaType !== mediaType
        || receipt.threadId !== this.threadId || this.attachments === undefined) {
        throw new Error(`agent-codex: audit artifact ${sha256} is not owned by this Session`)
      }
      const file: FileAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${sha256}`),
        name: receipt.name,
        bytes,
      }
      const hash = createHash('sha256')
      let actualBytes = 0
      try {
        for await (const chunk of this.attachments.readFileStream(file)) {
          hash.update(chunk)
          actualBytes += chunk.byteLength
          if (!Number.isSafeInteger(actualBytes) || actualBytes > bytes) {
            throw new Error('audit artifact exceeded its declared size')
          }
        }
      } catch (cause) {
        throw new Error(`agent-codex: audit artifact ${sha256} is missing or unreadable`, { cause })
      }
      if (actualBytes !== bytes || hash.digest('hex') !== sha256) {
        throw new Error(`agent-codex: audit artifact ${sha256} hash or size differs`)
      }
    }
  }

  private async resolvePayload(payload: CodexAuditPayloadV1): Promise<unknown> {
    if (payload.kind === 'inline') return payload.value
    const receipt = this.artifacts.get(payload.sha256)
    if (receipt === undefined || receipt.bytes !== payload.bytes
      || receipt.mediaType !== payload.mediaType || this.attachments === undefined) {
      throw new Error(`agent-codex: audit artifact ${payload.sha256} is not owned by this Session`)
    }
    const file: FileAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${payload.sha256}`),
      name: receipt.name,
      bytes: receipt.bytes,
    }
    const hash = createHash('sha256')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of this.attachments.readFileStream(file)) {
      bytes += chunk.byteLength
      if (!Number.isSafeInteger(bytes) || bytes > receipt.bytes) {
        throw new Error(`agent-codex: audit artifact ${payload.sha256} exceeds its receipt size`)
      }
      hash.update(chunk)
      chunks.push(chunk)
    }
    if (bytes !== receipt.bytes || hash.digest('hex') !== payload.sha256) {
      throw new Error(`agent-codex: audit artifact ${payload.sha256} hash or size differs`)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch (cause) {
      throw new Error(`agent-codex: audit artifact ${payload.sha256} is not valid JSON`, { cause })
    }
  }

  private currentCursor(): AuditCursor {
    return {
      version: 1,
      sequence: this.sequence,
      eventId: this.sequence === 0 ? null : this.facts.get(this.sequence)?.eventId ?? null,
    }
  }

  private enqueue<T>(run: () => T | Promise<T>): Promise<T> {
    const request = this.tail.then(async () => {
      if (this.failure !== undefined) throw this.failure
      try {
        return await run()
      } catch (cause) {
        this.failure = asError(cause)
        this.onFailure(this.failure)
        throw this.failure
      }
    })
    this.tail = request.then(() => {}, () => {})
    return request
  }
}
