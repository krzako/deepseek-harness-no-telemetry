import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { isPortableAgentContextV1 } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { codexJsonSha256, type CodexContextSnapshotV2 } from '../src/context-snapshot.ts'
import { codexPortableToolOutcomes, projectCodexEffectiveHistory, projectCodexHistoricalItems,
  projectCodexEffectiveHistoryStream, projectCodexHistoricalItemsStream,
  projectCodexResponseItem } from '../src/portable-item.ts'

const checkpoint = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2

function withHistory(history: readonly JsonValue[]): CodexContextSnapshotV2 {
  return { ...checkpoint, effectiveHistory: history, effectiveHistorySha256: codexJsonSha256([...history]) }
}

function withRollout(rollout: readonly JsonValue[]): CodexContextSnapshotV2 {
  return { ...checkpoint, rollout, rolloutSha256: codexJsonSha256([...rollout]) }
}

function bound(codexCallId: string, dshCallId: string, turn = 1): SessionEvent {
  return { type: 'codex/tool-call-bound', seq: 0, time: 1, data: {
    version: 1, turn, codexTurnId: 'turn-1', codexCallId, dshCallId,
    catalogHash: 'hash', name: 'read_file', arguments: {},
  } } as unknown as SessionEvent
}

function result(dshCallId: string, isError = false, turn = 1): SessionEvent {
  return { type: 'tool/result', seq: 1, time: 2, data: { turn, step: 1,
    message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: dshCallId,
      content: [{ type: 'text', text: 'result' }], isError }] },
  } } as unknown as SessionEvent
}

describe('Codex Responses item projection', () => {
  it('streams active history with the same audited tool and opaque projection as resident V2', async () => {
    const active = withHistory([
      { item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read' }] } },
      { item: { type: 'function_call_output', call_id: 'call-ok', output: 'result' } },
      { item: { type: 'future-variant', payload: { retained: true } } },
    ])
    const outcomes = codexPortableToolOutcomes([bound('call-ok', 'dsh-ok'), result('dsh-ok')])
    const items = []
    for await (const item of projectCodexEffectiveHistoryStream(Readable.from(active.effectiveHistory), outcomes)) {
      items.push(item)
    }
    expect(JSON.stringify(items)).toBe(JSON.stringify(projectCodexEffectiveHistory(active, outcomes)))
    let emitted = 0
    await expect((async () => {
      for await (const item of projectCodexEffectiveHistoryStream(Readable.from([
        active.effectiveHistory[0], { invalid: true },
      ]), outcomes)) { void item; emitted++ }
    })()).rejects.toThrow('no Responses item')
    expect(emitted).toBe(1)
  })

  it('projects every active item in checkpoint order without claiming compacted ancestors', () => {
    const history = projectCodexEffectiveHistory(checkpoint, new Map())
    expect(history).toEqual([{
      id: 'codex:response:0', role: 'assistant',
      provenance: { kind: 'model', sourceId: 'response-1' },
      content: [{ kind: 'text', text: 'final answer' }],
    }])
    expect(history).toHaveLength(checkpoint.effectiveHistory.length)
    expect(projectCodexEffectiveHistory(withHistory([]), new Map())).toEqual([])
  })

  it('projects audited outcomes and retains an unresolved function output as opaque', () => {
    const active = withHistory([
      { item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] } },
      { item: { type: 'function_call_output', call_id: 'call-ok', output: 'read' } },
      { item: { type: 'function_call_output', call_id: 'call-pending', output: 'unverified' } },
    ])
    const outcomes = codexPortableToolOutcomes([bound('call-ok', 'dsh-ok'), result('dsh-ok')])
    const items = projectCodexEffectiveHistory(active, outcomes)
    expect(items.map(item => item.id)).toEqual(['codex:response:0', 'codex:response:1', 'codex:response:2'])
    expect(items[1]?.content).toEqual([{ kind: 'tool-result', callId: 'call-ok', isError: false,
      content: [{ kind: 'text', text: 'read' }] }])
    expect(items[2]?.content).toEqual([{ kind: 'opaque', namespace: 'codex.responses.v1',
      value: { type: 'function_call_output', call_id: 'call-pending', output: 'unverified' } }])
  })

  it('rejects damaged checkpoints and malformed effective envelopes before transfer', () => {
    expect(() => projectCodexEffectiveHistory({ ...checkpoint, effectiveHistorySha256: '0'.repeat(64) }, new Map()))
      .toThrow('Invalid Codex V2 checkpoint')
    expect(() => projectCodexEffectiveHistory(withHistory([null]), new Map()))
      .toThrow('no Responses item')
  })

  it('projects pre-compaction response items and every installed replacement in rollout order', () => {
    const source = withRollout([
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'before' }] }, metadata: { client_authored: true } },
      { type: 'event_msg', payload: { type: 'unrelated_event' } },
      ...checkpoint.rollout,
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-ok', output: 'after' } },
    ])
    const outcomes = codexPortableToolOutcomes([bound('call-ok', 'dsh-ok'), result('dsh-ok')])
    const history = projectCodexHistoricalItems(source, outcomes)
    expect(history.items.map(item => item.id)).toEqual([
      'codex:response:1', 'codex:response:2', 'codex:response:3', 'codex:response:4',
    ])
    expect(history.items[0]?.content).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'opaque', namespace: 'codex.responses.v1', value: { metadata: { client_authored: true } } },
    ])
    expect(history.compactionOutputs).toEqual([
      { id: 'first', outputItemIds: ['codex:response:2'] },
      { id: 'second', outputItemIds: ['codex:response:3'] },
    ])
    expect(history.items[3]?.content).toEqual([{ kind: 'tool-result', callId: 'call-ok', isError: false,
      content: [{ kind: 'text', text: 'after' }] }])
    expect(projectCodexEffectiveHistory(source, outcomes).map(item => item.id)).toEqual(['codex:response:0'])
  })

  it('streams historical rollout items and ordered compaction output references without a resident item array', async () => {
    const source = withRollout([
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'before' }] }, metadata: { client_authored: true } },
      ...checkpoint.rollout,
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-ok', output: 'after' } },
    ])
    const outcomes = codexPortableToolOutcomes([bound('call-ok', 'dsh-ok'), result('dsh-ok')])
    const expected = projectCodexHistoricalItems(source, outcomes)
    const compactionOutputs: { id: string; outputItemIds: readonly string[] }[] = []
    const items = []
    for await (const item of projectCodexHistoricalItemsStream(
      Readable.from(source.rollout), Readable.from(source.compactions), source.effectiveHistory.length,
      outcomes, (output) => { compactionOutputs.push(output) },
    )) items.push(item)
    expect(JSON.stringify(items)).toBe(JSON.stringify(expected.items))
    expect(compactionOutputs).toEqual(expected.compactionOutputs)
    await expect((async () => {
      for await (const item of projectCodexHistoricalItemsStream(
        Readable.from(source.rollout), Readable.from([]), source.effectiveHistory.length,
        outcomes, () => {},
      )) void item
    })()).rejects.toThrow('compaction missing')
    await expect((async () => {
      for await (const item of projectCodexHistoricalItemsStream(
        Readable.from([]), Readable.from(source.compactions), source.effectiveHistory.length,
        outcomes, () => {},
      )) void item
    })()).rejects.toThrow('extra compaction')
  })

  it('rejects a missing rollout response payload and corrupted compaction chain', () => {
    expect(() => projectCodexHistoricalItems(withRollout([
      { type: 'response_item' }, ...checkpoint.rollout,
    ]), new Map())).toThrow('no payload')
    expect(() => projectCodexHistoricalItems({ ...checkpoint, compactions: [] }, new Map()))
      .toThrow('Invalid Codex V2 checkpoint')
  })

  it('uses only settled DSH tool results for function-output outcomes', () => {
    const outcomes = codexPortableToolOutcomes([
      bound('call-ok', 'dsh-ok'), bound('call-error', 'dsh-error'), bound('call-pending', 'dsh-pending'),
      result('dsh-ok'), result('dsh-error', true),
    ])
    expect([...outcomes]).toEqual([['call-ok', 'success'], ['call-error', 'error']])
    expect(outcomes.has('call-pending')).toBe(false)
    const item = { item: { type: 'function_call_output', call_id: 'call-error', output: 'failed' } }
    expect(projectCodexResponseItem(item, 0, outcomes.get('call-error')).content)
      .toEqual([{ kind: 'tool-result', callId: 'call-error', isError: true,
        content: [{ kind: 'text', text: 'failed' }] }])
    expect(projectCodexResponseItem(item, 0, outcomes.get('call-pending')).content[0]?.kind).toBe('opaque')
  })

  it('rejects duplicate bindings and unbound, mismatched, or duplicate results', () => {
    expect(() => codexPortableToolOutcomes([bound('call-1', 'dsh-1'), bound('call-1', 'dsh-2')]))
      .toThrow('duplicate portable tool binding')
    expect(() => codexPortableToolOutcomes([bound('call-1', 'dsh-1'), bound('call-2', 'dsh-1')]))
      .toThrow('duplicate portable tool binding')
    expect(() => codexPortableToolOutcomes([result('unbound')])).toThrow('unbound, conflicting, or duplicate')
    expect(() => codexPortableToolOutcomes([bound('call-1', 'dsh-1'), result('dsh-1', false, 2)]))
      .toThrow('unbound, conflicting, or duplicate')
    expect(() => codexPortableToolOutcomes([bound('call-1', 'dsh-1'), result('dsh-1'), result('dsh-1')]))
      .toThrow('unbound, conflicting, or duplicate')
  })

  it('maps ordered text and retains image, phase, and envelope metadata as opaque content', () => {
    const item = projectCodexResponseItem({
      item: { type: 'message', id: 'message-1', role: 'user', phase: 'final_answer', content: [
        { type: 'input_text', text: 'hello' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
      ] }, metadata: { client_authored: true },
    }, 0)
    expect(item).toEqual({
      id: 'codex:response:0', role: 'user', provenance: { kind: 'user', sourceId: 'message-1' },
      content: [
        { kind: 'text', text: 'hello' },
        { kind: 'opaque', namespace: 'codex.responses.v1',
          value: { type: 'input_image', image_url: 'data:image/png;base64,AA==' } },
        { kind: 'opaque', namespace: 'codex.responses.v1', value: { phase: 'final_answer' } },
        { kind: 'opaque', namespace: 'codex.responses.v1', value: { metadata: { client_authored: true } } },
      ],
    })
  })

  it('maps reasoning and function calls while retaining unsupported fields', () => {
    const reasoning = projectCodexResponseItem({ item: { type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'summary' }],
      content: [{ type: 'reasoning_text', text: 'visible detail' }],
      encrypted_content: 'encrypted',
    } }, 1)
    expect(reasoning.content).toEqual([
      { kind: 'reasoning', text: 'summary' },
      { kind: 'reasoning', text: 'visible detail' },
      { kind: 'opaque', namespace: 'codex.responses.v1', value: {
        summary: [{ type: 'summary_text', text: 'summary' }],
        content: [{ type: 'reasoning_text', text: 'visible detail' }],
      } },
      { kind: 'opaque', namespace: 'codex.responses.v1', value: { encrypted_content: 'encrypted' } },
    ])
    const call = projectCodexResponseItem({ item: { type: 'function_call', call_id: 'call-1',
      name: 'read_file', arguments: '{"path":"a"}', namespace: 'functions' } }, 2)
    expect(call.content).toEqual([
      { kind: 'tool-call', callId: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
      { kind: 'opaque', namespace: 'codex.responses.v1', value: { namespace: 'functions' } },
    ])
  })

  it('needs an audited outcome before classifying a function result', () => {
    const envelope = { item: { type: 'function_call_output', call_id: 'call-1',
      output: [{ type: 'input_text', text: 'done' }, { type: 'input_audio', audio_url: 'data:audio/wav;base64,AA==' }] } }
    const unknown = projectCodexResponseItem(envelope, 3)
    expect(unknown.role).toBe('tool')
    expect(unknown.content).toEqual([{ kind: 'opaque', namespace: 'codex.responses.v1', value: envelope.item }])
    const failed = projectCodexResponseItem(envelope, 3, 'error')
    expect(failed.role).toBe('tool')
    expect(failed.content).toEqual([{ kind: 'tool-result', callId: 'call-1', isError: true, content: [
      { kind: 'text', text: 'done' },
      { kind: 'opaque', namespace: 'codex.responses.v1',
        value: { type: 'input_audio', audio_url: 'data:audio/wav;base64,AA==' } },
    ] }])
    expect(projectCodexResponseItem({ item: { type: 'function_call_output', call_id: 'call-1', output: 'ok' } }, 4, 'success')
      .content).toEqual([{ kind: 'tool-result', callId: 'call-1', isError: false,
      content: [{ kind: 'text', text: 'ok' }] }])
  })

  it('preserves unknown variants and yields valid canonical items', () => {
    const item = projectCodexResponseItem({ item: { type: 'new_future_item', payload: { secret: 'kept' } } }, 5)
    expect(item.content).toEqual([{ kind: 'opaque', namespace: 'codex.responses.v1',
      value: { type: 'new_future_item', payload: { secret: 'kept' } } }])
    expect(isPortableAgentContextV1({
      version: 1,
      source: { version: 1, sessionId: 's', driver: { id: 'codex', version: '1' },
        model: { provider: 'p', id: 'm' } },
      items: [item], effectiveItemIds: [item.id], compactions: [],
    })).toBe(true)
    expect(() => projectCodexResponseItem({ item: {} }, -1)).toThrow('nonnegative')
    expect(() => projectCodexResponseItem({ item: null }, 0)).toThrow('no Responses item')
    expect(projectCodexResponseItem({ item: { type: 'message', id: { unexpected: true },
      role: 'user', content: [{ type: 'input_text', text: 'not lost' }] } }, 6).content)
      .toEqual([{ kind: 'opaque', namespace: 'codex.responses.v1', value: {
        type: 'message', id: { unexpected: true }, role: 'user', content: [{ type: 'input_text', text: 'not lost' }],
      } }])
  })
})
