import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { isPortableAgentContextV1 } from '../src/portable-session.ts'
import { projectStandardSession, projectStandardSessionStream } from '../src/standard-session-export.ts'

async function collectedStream(session: Session) {
  const streamed = projectStandardSessionStream(session)
  const items = []
  for await (const item of streamed.items) items.push(item)
  const effectiveItemIds = []
  for await (const id of streamed.effectiveItemIds) effectiveItemIds.push(id)
  const compactions = []
  for await (const compaction of streamed.compactions) compactions.push(compaction)
  return { version: streamed.version, source: streamed.source, items, effectiveItemIds, compactions }
}

function session(): Session {
  const result = Session.create(SessionId('standard-session'))
  result.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'mock', model: 'model-1' }, system: 'Follow instructions' },
  })
  return result
}

describe('standard Session portable projection', () => {
  it('preserves ordered messages, tool correlation, system instructions, and a later model route', async () => {
    const source = session()
    const callId = ToolCallId('call-1')
    source.append('turn/start', { turn: 1 })
    const user = source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Read the file' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const assistant = source.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'model-1' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a"}' }] }),
    }, { surfaceOp: 'append' })
    const tool = source.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'contents' }], isError: false }),
    }, { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.append('request/header', {
      reason: 'change', header: { config: { provider: 'mock', model: 'model-2' }, system: 'Updated instructions' },
    })

    const exported = projectStandardSession(source)
    expect(JSON.stringify(await collectedStream(source))).toBe(JSON.stringify(exported))
    expect(isPortableAgentContextV1(exported)).toBe(true)
    expect(exported.source).toMatchObject({ driver: { id: 'standard' }, model: { provider: 'mock', id: 'model-2' } })
    expect(exported.effectiveItemIds).toEqual([
      'standard:system:6', `standard:event:${user.seq}`, `standard:event:${assistant.seq}`, `standard:event:${tool.seq}`,
    ])
    expect(exported.items.find(item => item.id === `standard:event:${assistant.seq}`)?.content)
      .toEqual([{ kind: 'tool-call', callId, name: 'read', arguments: '{"path":"a"}' }])
    expect(exported.items.find(item => item.id === `standard:event:${tool.seq}`)).toMatchObject({
      role: 'tool', content: [{ kind: 'tool-result', callId, content: [{ kind: 'text', text: 'contents' }], isError: false }],
    })
  })

  it('retains shadowed history and exports the installed replacement as effective context', async () => {
    const source = session()
    source.append('turn/start', { turn: 1 })
    const original = source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'long prompt' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const replacement = source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compaction' },
    }), { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })

    const exported = projectStandardSession(source)
    expect(JSON.stringify(await collectedStream(source))).toBe(JSON.stringify(exported))
    expect(exported.items.map(item => item.id)).toContain(`standard:event:${original.seq}`)
    expect(exported.effectiveItemIds).toEqual(['standard:system:0', `standard:event:${replacement.seq}`])
    expect(exported.compactions).toEqual([{
      id: `standard:replacement:${replacement.seq}`, mode: 'local',
      inputItemIds: [`standard:event:${original.seq}`], outputItemIds: [`standard:event:${replacement.seq}`],
      promptItemIds: [], resultItemIds: [`standard:event:${replacement.seq}`],
    }])
  })

  it('keeps attachment references and refuses a partial turn or missing route', async () => {
    const source = session()
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: {
          attachmentId: 'image-id' as never, mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'x.png',
        } },
        { type: 'file', attachment: { attachmentId: 'file-id' as never, name: 'notes.txt', bytes: 7 } },
      ], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => projectStandardSession(source)).toThrow('active')
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(JSON.stringify(await collectedStream(source))).toBe(JSON.stringify(projectStandardSession(source)))
    expect(projectStandardSession(source).items.at(-1)?.content).toEqual([
      { kind: 'attachment', attachmentId: 'image-id', mediaType: 'image/png', name: 'x.png' },
      { kind: 'attachment', attachmentId: 'file-id', mediaType: 'application/octet-stream', name: 'notes.txt' },
    ])
    expect(() => projectStandardSession(Session.create(SessionId('empty')))).toThrow('no request header')
  })

  it('keeps the acquired stream on its frozen Session snapshot after a later append', async () => {
    const source = session()
    const expected = projectStandardSession(source)
    const streamed = projectStandardSessionStream(source)
    source.append('request/header', {
      reason: 'change', header: { config: { provider: 'mock', model: 'model-2' }, system: 'Later instruction' },
    })
    const items = []
    for await (const item of streamed.items) items.push(item)
    expect(items).toEqual(expected.items)
    expect(streamed.source).toEqual(expected.source)
  })

  it('rejects a non-standard owner, unfinished standalone compaction, and unknown content', () => {
    const wrongDriver = session()
    wrongDriver.append('agent/driver-selected', { version: 1, driverId: 'codex' })
    expect(() => projectStandardSession(wrongDriver)).toThrow('not the standard driver')

    const activeCompaction = session()
    const withCompaction = activeCompaction as unknown as { append(type: string, data: unknown): unknown }
    withCompaction.append('compaction/start', { compactionId: 'compact-1', turn: null })
    expect(() => projectStandardSession(activeCompaction)).toThrow('compaction is active')

    const unknown = session()
    unknown.append('user/message', createUserMessage({
      content: [{ type: 'future-audio', payload: 'bytes' } as never], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => projectStandardSession(unknown)).toThrow('unsupported content block')
  })
})
