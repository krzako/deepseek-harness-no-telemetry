/** Bounded, session-owned transfer of byte-exact Codex audit artifacts. */

import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CodexAuditArtifactReceipt, CodexAuditReceiver } from './audit-receiver.ts'

export const CODEX_AUDIT_ARTIFACT_CHUNK_BYTES = 256 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const MEDIA_TYPE = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/

export interface CodexAuditArtifactChunk {
  readonly threadId: string
  readonly sha256: string
  readonly bytes: number
  readonly mediaType: string
  readonly offset: number
  readonly data: string
}

export interface CodexAuditArtifactAck {
  readonly version: 1
  readonly sha256: string
  readonly bytes: number
  readonly nextOffset: number
  readonly complete: boolean
}

interface Upload {
  readonly directory: string
  readonly path: string
  readonly file: FileHandle
  readonly bytes: number
  readonly mediaType: string
  offset: number
}

export function codexAuditArtifactName(sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('agent-codex: invalid audit artifact digest')
  return `dsh-audit-${sha256}.blob`
}

/** Acknowledges a final chunk only after AttachmentStore and Session both flush. */
export class CodexAuditArtifactReceiver {
  private readonly uploads = new Map<string, Upload>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly threadId: string,
    private readonly attachments: AttachmentStore,
    private readonly audit: CodexAuditReceiver,
  ) {}

  upload(value: unknown): Promise<CodexAuditArtifactAck> {
    const request = this.tail.then(() => this.uploadOne(value))
    this.tail = request.then(() => {}, () => {})
    return request
  }

  async dispose(): Promise<void> {
    await this.tail
    for (const upload of this.uploads.values()) await this.cleanup(upload)
    this.uploads.clear()
  }

  private async uploadOne(value: unknown): Promise<CodexAuditArtifactAck> {
    const chunk = this.parseChunk(value)
    const committed = this.audit.artifact(chunk.sha256)
    if (committed !== undefined) {
      this.assertReceipt(committed, chunk)
      return { version: 1, sha256: chunk.sha256, bytes: chunk.bytes,
        nextOffset: chunk.bytes, complete: true }
    }
    let upload = this.uploads.get(chunk.sha256)
    if (upload === undefined) {
      if (chunk.offset !== 0) return this.ack(chunk, 0, false)
      const directory = await mkdtemp(join(tmpdir(), 'dsh-audit-artifact-'))
      const path = join(directory, 'payload')
      try {
        const file = await open(path, 'wx', 0o600)
        upload = { directory, path, file, bytes: chunk.bytes, mediaType: chunk.mediaType, offset: 0 }
        this.uploads.set(chunk.sha256, upload)
      } catch (cause) {
        await rm(directory, { recursive: true, force: true })
        throw cause
      }
    }
    if (upload.bytes !== chunk.bytes || upload.mediaType !== chunk.mediaType) {
      throw new Error('agent-codex: audit artifact upload metadata changed')
    }
    if (chunk.offset !== upload.offset) return this.ack(chunk, upload.offset, false)
    const data = Buffer.from(chunk.data, 'base64')
    if (upload.offset + data.byteLength > upload.bytes) {
      throw new Error('agent-codex: audit artifact exceeds declared size')
    }
    try {
      let written = 0
      while (written < data.byteLength) {
        const result = await upload.file.write(data, written, data.byteLength - written, upload.offset + written)
        if (result.bytesWritten === 0) throw new Error('agent-codex: zero-length artifact write')
        written += result.bytesWritten
      }
      await upload.file.sync()
      upload.offset += data.byteLength
      if (upload.offset !== upload.bytes) return this.ack(chunk, upload.offset, false)
      await upload.file.close()
      const name = codexAuditArtifactName(chunk.sha256)
      const stored = await this.attachments.saveFileStream({ data: createReadStream(upload.path), name })
      if (String(stored.attachmentId) !== `sha256:${chunk.sha256}`
        || stored.bytes !== chunk.bytes || stored.name !== name) {
        throw new Error('agent-codex: stored audit artifact hash or size differs')
      }
      await this.audit.commitArtifact({
        version: 1, threadId: this.threadId, sha256: chunk.sha256,
        bytes: chunk.bytes, mediaType: chunk.mediaType, name,
      })
      return this.ack(chunk, upload.offset, true)
    } catch (cause) {
      throw cause
    } finally {
      if (upload.offset === upload.bytes) {
        this.uploads.delete(chunk.sha256)
        await this.cleanup(upload)
      }
    }
  }

  private async cleanup(upload: Upload): Promise<void> {
    await upload.file.close().catch(() => {})
    await rm(upload.directory, { recursive: true, force: true })
  }

  private ack(chunk: CodexAuditArtifactChunk, nextOffset: number, complete: boolean): CodexAuditArtifactAck {
    return { version: 1, sha256: chunk.sha256, bytes: chunk.bytes, nextOffset, complete }
  }

  private assertReceipt(receipt: CodexAuditArtifactReceipt, chunk: CodexAuditArtifactChunk): void {
    if (receipt.threadId !== this.threadId || receipt.bytes !== chunk.bytes
      || receipt.mediaType !== chunk.mediaType
      || receipt.name !== codexAuditArtifactName(chunk.sha256)) {
      throw new Error('agent-codex: audit artifact receipt conflicts with upload')
    }
  }

  private parseChunk(value: unknown): CodexAuditArtifactChunk {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('agent-codex: invalid audit artifact chunk')
    }
    const chunk = value as Record<string, unknown>
    if (chunk.threadId !== this.threadId || typeof chunk.sha256 !== 'string' || !SHA256.test(chunk.sha256)
      || typeof chunk.mediaType !== 'string' || chunk.mediaType.length > 256 || !MEDIA_TYPE.test(chunk.mediaType)
      || typeof chunk.bytes !== 'number' || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0
      || typeof chunk.offset !== 'number' || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0
      || typeof chunk.data !== 'string'
      || chunk.data.length > Math.ceil(CODEX_AUDIT_ARTIFACT_CHUNK_BYTES / 3) * 4) {
      throw new Error('agent-codex: invalid audit artifact chunk metadata')
    }
    const data = Buffer.from(chunk.data, 'base64')
    if (data.byteLength > CODEX_AUDIT_ARTIFACT_CHUNK_BYTES || data.toString('base64') !== chunk.data
      || (data.byteLength === 0 && chunk.bytes !== 0)) {
      throw new Error('agent-codex: invalid audit artifact chunk encoding')
    }
    return chunk as unknown as CodexAuditArtifactChunk
  }
}
