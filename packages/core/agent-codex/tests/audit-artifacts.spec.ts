import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CodexAuditReceiver } from '../src/audit-receiver.ts'
import { CODEX_AUDIT_ARTIFACT_CHUNK_BYTES, CodexAuditArtifactReceiver } from '../src/audit-artifacts.ts'

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function chunk(sha256: string, bytes: number, offset: number, data: Uint8Array) {
  return { threadId: 'thread-1', sha256, bytes, mediaType: 'application/json', offset,
    data: Buffer.from(data).toString('base64') }
}

function fakeAttachments(save?: (data: Uint8Array) => Promise<void>) {
  const store = {
    saveFileStream: vi.fn(async (input: { data: AsyncIterable<Uint8Array>; name?: string }) => {
      const chunks: Uint8Array[] = []
      for await (const part of input.data) chunks.push(part)
      const bytes = Buffer.concat(chunks)
      await save?.(bytes)
      return { attachmentId: `sha256:${digest(bytes)}` as never, bytes: bytes.length,
        name: input.name ?? 'file' }
    }),
  }
  return { store: store as unknown as AttachmentStore, saveFileStream: store.saveFileStream }
}

describe('Codex audit artifact transfer', () => {
  it('uploads bounded chunks, flushes a session-owned receipt, and deduplicates after restart', async () => {
    const bytes = Buffer.from('{"prompt":"pełna treść, bez redakcji"}')
    const sha256 = digest(bytes)
    const session = Session.create(SessionId('artifact-session'))
    const flush = vi.fn().mockResolvedValue(true)
    const audit = new CodexAuditReceiver(session, 'thread-1', flush, vi.fn())
    const attachments = fakeAttachments()
    const receiver = new CodexAuditArtifactReceiver('thread-1', attachments.store, audit)
    try {
      await expect(receiver.upload(chunk(sha256, bytes.length, 10, bytes.subarray(10))))
        .resolves.toMatchObject({ complete: false, nextOffset: 0 })
      await expect(receiver.upload(chunk(sha256, bytes.length, 0, bytes.subarray(0, 10))))
        .resolves.toMatchObject({ complete: false, nextOffset: 10 })
      await expect(receiver.upload(chunk(sha256, bytes.length, 0, bytes.subarray(0, 10))))
        .resolves.toMatchObject({ complete: false, nextOffset: 10 })
      await expect(receiver.upload(chunk(sha256, bytes.length, 10, bytes.subarray(10))))
        .resolves.toMatchObject({ complete: true, nextOffset: bytes.length })
      expect(flush).toHaveBeenCalledOnce()
      expect(session.snapshotEvents().filter(event => event.type === 'codex/artifact-v1'))
        .toHaveLength(1)
      expect(attachments.saveFileStream).toHaveBeenCalledOnce()
    } finally {
      await receiver.dispose()
    }

    const restored = Session.create(SessionId('artifact-restored'), session.snapshotEvents())
    const replay = new CodexAuditArtifactReceiver('thread-1', attachments.store,
      new CodexAuditReceiver(restored, 'thread-1', async () => true, vi.fn()))
    try {
      await expect(replay.upload(chunk(sha256, bytes.length, 0, bytes.subarray(0, 10))))
        .resolves.toMatchObject({ complete: true, nextOffset: bytes.length })
      expect(attachments.saveFileStream).toHaveBeenCalledOnce()
    } finally {
      await replay.dispose()
    }
  })

  it('does not ACK a final chunk until storage and the Session flush finish', async () => {
    const bytes = Buffer.from('complete result')
    const sha256 = digest(bytes)
    const saved = Promise.withResolvers<undefined>()
    const flushed = Promise.withResolvers<boolean>()
    const session = Session.create(SessionId('artifact-gated'))
    const audit = new CodexAuditReceiver(session, 'thread-1', () => flushed.promise, vi.fn())
    const receiver = new CodexAuditArtifactReceiver('thread-1', fakeAttachments(async () => saved.promise).store, audit)
    try {
      const completion = receiver.upload(chunk(sha256, bytes.length, 0, bytes))
      let settled = false
      void completion.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(settled).toBe(false)
      saved.resolve(undefined)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(settled).toBe(false)
      flushed.resolve(true)
      await expect(completion).resolves.toMatchObject({ complete: true })
    } finally {
      await receiver.dispose()
    }
  })

  it('rejects wrong owners, malformed chunks, and a false final digest', async () => {
    const bytes = Buffer.from('full payload')
    const sha256 = digest(bytes)
    const session = Session.create(SessionId('artifact-invalid'))
    const audit = new CodexAuditReceiver(session, 'thread-1', async () => true, vi.fn())
    const receiver = new CodexAuditArtifactReceiver('thread-1', fakeAttachments().store, audit)
    try {
      await expect(receiver.upload({ ...chunk(sha256, bytes.length, 0, bytes), threadId: 'other' }))
        .rejects.toThrow('invalid audit artifact chunk metadata')
      await expect(receiver.upload({ ...chunk(sha256, bytes.length, 0, bytes), data: 'not-base64' }))
        .rejects.toThrow('invalid audit artifact chunk encoding')
      await expect(receiver.upload(chunk(sha256, CODEX_AUDIT_ARTIFACT_CHUNK_BYTES + 1, 0,
        new Uint8Array(CODEX_AUDIT_ARTIFACT_CHUNK_BYTES + 1))))
        .rejects.toThrow('invalid audit artifact chunk encoding')
      await expect(receiver.upload(chunk('a'.repeat(64), bytes.length, 0, bytes)))
        .rejects.toThrow('hash or size differs')
      expect(session.snapshotEvents().filter(event => event.type === 'codex/artifact-v1'))
        .toHaveLength(0)
    } finally {
      await receiver.dispose()
    }
  })

  it('refuses final ACK when the Session receipt cannot be durably flushed', async () => {
    const bytes = Buffer.from('secret prompt')
    const sha256 = digest(bytes)
    const session = Session.create(SessionId('artifact-flush-failed'))
    const audit = new CodexAuditReceiver(session, 'thread-1', async () => false, vi.fn())
    const receiver = new CodexAuditArtifactReceiver('thread-1', fakeAttachments().store, audit)
    try {
      await expect(receiver.upload(chunk(sha256, bytes.length, 0, bytes)))
        .rejects.toThrow('durable audit artifact storage is unavailable')
      expect(audit.artifact(sha256)).toBeUndefined()
      await expect(audit.cursor()).rejects.toThrow('durable audit artifact storage is unavailable')
    } finally {
      await receiver.dispose()
    }
  })
})
