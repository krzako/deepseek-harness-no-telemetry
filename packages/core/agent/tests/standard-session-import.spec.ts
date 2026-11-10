import { portableAttachmentKey } from '../src/portable-session.ts'
import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PortableAgentContextV1 } from '../src/portable-session.ts'
import { projectStandardImport } from '../src/standard-session-import.ts'
import { projectStandardSession } from '../src/standard-session-export.ts'

const context: PortableAgentContextV1 = {
  version: 1,
  source: {
    version: 1, sessionId: 'source', driver: { id: 'codex', version: '1' },
    model: { provider: 'old-provider', id: 'old-model' },
  },
  items: [
    { id: 'instruction', role: 'system', content: [{ kind: 'text', text: 'old instruction' }], provenance: { kind: 'instruction' } },
    { id: 'user', role: 'user', content: [{ kind: 'attachment', attachmentId: 'image-1', mediaType: 'image/png', name: 'a.png' }], provenance: { kind: 'user' } },
    { id: 'assistant', role: 'assistant', content: [{ kind: 'tool-call', callId: 'call-1', name: 'read', arguments: '{"path":"a"}' }], provenance: { kind: 'model' } },
    { id: 'tool', role: 'tool', content: [{ kind: 'tool-result', callId: 'call-1', content: [{ kind: 'text', text: 'result' }], isError: false }], provenance: { kind: 'tool' } },
    { id: 'shadowed', role: 'user', content: [{ kind: 'text', text: 'old' }], provenance: { kind: 'user' } },
  ],
  effectiveItemIds: ['instruction', 'user', 'assistant', 'tool'],
  compactions: [],
}

const image = { type: 'image', attachment: {
  attachmentId: 'image-1' as never, mediaType: 'image/png', name: 'a.png', bytes: 4, width: 1, height: 1,
} } satisfies Extract<ContentBlock, { type: 'image' }>
const attachments = new Map([[portableAttachmentKey(image.attachment), image]])

describe('standard import projection', () => {
  it('preserves image and differently named file references sharing the same digest', () => {
    const blocks: Extract<ContentBlock, { type: 'image' | 'file' }>[] = [image,
      { type: 'file', attachment: { attachmentId: image.attachment.attachmentId, bytes: 4, name: 'a.bin' } },
      { type: 'file', attachment: { attachmentId: image.attachment.attachmentId, bytes: 4, name: 'b.bin' } }]
    const content = blocks.map(block => ({ kind: 'attachment' as const, attachmentId: String(block.attachment.attachmentId),
      mediaType: block.type === 'image' ? block.attachment.mediaType : 'application/octet-stream', name: block.attachment.name! }))
    const portable: PortableAgentContextV1 = { ...context, items: [{ id: 'user', role: 'user', content, provenance: { kind: 'user' } }],
      effectiveItemIds: ['user'] }
    const refs = new Map(content.map((block, index) => [portableAttachmentKey(block), blocks[index]!] as const))
    const projection = projectStandardImport(portable, SessionId('new'), { provider: 'p', id: 'm' }, refs)
    expect(projection.entries[0]).toMatchObject({ kind: 'message', message: { content: blocks } })
    expect(new Set(content.map(portableAttachmentKey)).size).toBe(3)
    expect(portableAttachmentKey({ attachmentId: 'a', mediaType: 'b' }))
      .not.toBe(portableAttachmentKey({ attachmentId: 'a', mediaType: 'b', name: '' }))
  })

  it('retains effective order and tool correlation without invoking historical work', () => {
    const projection = projectStandardImport(context, SessionId('new-session'), { provider: 'target', id: 'new-model' }, attachments)
    expect(projection.entries.map(entry => entry.sourceItemId)).toEqual(['instruction', 'user', 'assistant', 'tool'])
    expect(projection.entries[0]).toEqual({
      kind: 'instruction', sourceItemId: 'instruction', role: 'system', content: [{ type: 'text', text: 'old instruction' }],
    })
    expect(projection.entries[1]).toMatchObject({
      kind: 'message', message: { id: 'new-session:import:user', role: 'user', content: [image] },
    })
    expect(projection.entries[2]).toMatchObject({
      kind: 'message', message: {
        id: 'new-session:import:assistant', role: 'assistant',
        source: { kind: 'model', provider: 'target', model: 'new-model' },
        content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }],
      },
    })
    expect(projection.entries[3]).toMatchObject({
      kind: 'message', message: {
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }], isError: false }],
      },
    })
    expect(projectStandardImport(context, SessionId('new-session'), { provider: 'target', id: 'new-model' }, attachments))
      .toEqual(projection)
  })

  it('rejects missing or inconsistent attachments and unsupported content', () => {
    expect(() => projectStandardImport(context, SessionId('new'), { provider: 'p', id: 'm' }, new Map()))
      .toThrow('missing or inconsistent')
    const wrongName = new Map([[portableAttachmentKey(image.attachment), { ...image, attachment: { ...image.attachment, name: 'b.png' } } as never]])
    expect(() => projectStandardImport(context, SessionId('new'), { provider: 'p', id: 'm' }, wrongName))
      .toThrow('missing or inconsistent')
    const withRefusal: PortableAgentContextV1 = {
      ...context, items: context.items.map(item => item.id === 'assistant'
        ? { ...item, content: [{ kind: 'refusal', text: 'no' }] } : item),
    }
    expect(() => projectStandardImport(withRefusal, SessionId('new'), { provider: 'p', id: 'm' }, attachments))
      .toThrow('cannot import portable refusal')
  })

  it('does not turn malformed tool items into user messages', () => {
    const malformed: PortableAgentContextV1 = {
      ...context, items: context.items.map(item => item.id === 'tool'
        ? { ...item, content: [{ kind: 'text', text: 'fake tool result' }] } : item),
    }
    expect(() => projectStandardImport(malformed, SessionId('new'), { provider: 'p', id: 'm' }, attachments))
      .toThrow('exactly one tool result')
  })

  it('round-trips standard effective history after a replacement without replaying shadowed items', () => {
    const source = Session.create(SessionId('source-standard'))
    source.append('request/header', { reason: 'initial', header: {
      config: { provider: 'mock', model: 'old' }, system: 'source instructions',
    } })
    source.append('turn/start', { turn: 1 })
    const old = source.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'long request' }],
    }), { surfaceOp: 'append' })
    source.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'old' },
        content: [{ type: 'text', text: 'answer' }] }),
    }, { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: 'compaction' }, content: [{ type: 'text', text: 'summary' }],
    }), { surfaceOp: { op: 'replace', start: old.seq, end: old.seq }, sourceEventSeqs: [old.seq] })

    const portable = projectStandardSession(source)
    const projected = projectStandardImport(portable, SessionId('target-standard'), { provider: 'mock', id: 'new' }, new Map())
    expect(projected.entries.map(entry => entry.kind)).toEqual(['instruction', 'message', 'message'])
    expect(projected.entries[1]).toMatchObject({ kind: 'message', message: { content: [{ type: 'text', text: 'summary' }] } })
    expect(projected.entries[2]).toMatchObject({ kind: 'message', message: { content: [{ type: 'text', text: 'answer' }] } })
    expect(projected.entries.some(entry => entry.kind === 'message'
      && entry.message.content.some(block => block.type === 'text' && block.text === 'long request'))).toBe(false)
  })
})
