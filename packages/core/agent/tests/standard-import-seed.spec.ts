import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { PortableAgentContextV1 } from '../src/portable-session.ts'
import { projectStandardImport } from '../src/standard-session-import.ts'
import { buildStandardImportSeed } from '../src/standard-import-seed.ts'
import type { StandardImportPreparation } from '../src/standard-transfer-ports.ts'

const sourceId = SessionId('source')
const targetId = SessionId('target')
const targetModel = { provider: 'mock', id: 'model' }

const context: PortableAgentContextV1 = {
  version: 1,
  source: {
    version: 1, sessionId: sourceId, driver: { id: 'codex', version: '1' },
    model: { provider: 'source-provider', id: 'source-model' },
  },
  items: [
    { id: 'instruction', role: 'developer', content: [{ kind: 'text', text: 'source guidance' }], provenance: { kind: 'instruction' } },
    { id: 'user-1', role: 'user', content: [{ kind: 'text', text: 'read' }], provenance: { kind: 'user' } },
    { id: 'assistant-1', role: 'assistant', content: [{ kind: 'tool-call', callId: 'call-1', name: 'read', arguments: '{}' }], provenance: { kind: 'model' } },
    { id: 'result-1', role: 'tool', content: [{ kind: 'tool-result', callId: 'call-1', content: [{ kind: 'text', text: 'file contents' }], isError: false }], provenance: { kind: 'tool' } },
    { id: 'assistant-2', role: 'assistant', content: [{ kind: 'text', text: 'done' }], provenance: { kind: 'model' } },
  ],
  effectiveItemIds: ['instruction', 'user-1', 'assistant-1', 'result-1', 'assistant-2'],
  compactions: [],
}

function preparation(portable = context): StandardImportPreparation {
  return {
    context: portable,
    projection: projectStandardImport(portable, targetId, targetModel, new Map()),
    targetSessionId: targetId,
    targetModel,
    lineage: { sourceSessionId: sourceId, sourceDriverId: 'codex', importId: 'import-1' },
  }
}

describe('standard imported Session seed', () => {
  it('replays the same effective message order with balanced tool calls and separate instructions', async () => {
    const seed = buildStandardImportSeed(preparation())
    expect(seed.instructions).toEqual([{
      kind: 'instruction', sourceItemId: 'instruction', role: 'developer',
      content: [{ type: 'text', text: 'source guidance' }],
    }])
    const loaded = Session.create(targetId, seed.events)
    expect(loaded.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'read' }],
      [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
      [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }], isError: false }],
      [{ type: 'text', text: 'done' }],
    ])
    expect(seed.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(seed.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(seed.events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(seed.events.filter(event => event.type === 'turn/end')).toHaveLength(2)
    expect(loaded.snapshotEvents().find(event => event.type === 'agent/driver-selected')?.data)
      .toEqual({ version: 1, driverId: 'standard' })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SessionInvariant)
    expect(() => ctx.sessions.create(targetId, { seed: seed.events })).not.toThrow()
  })

  it('rejects an orphan result and an unresolved call instead of inventing execution', () => {
    const orphan = { ...context, effectiveItemIds: ['result-1'] }
    expect(() => buildStandardImportSeed(preparation(orphan))).toThrow('no pending call')
    const unresolved = { ...context, effectiveItemIds: ['assistant-1'] }
    expect(() => buildStandardImportSeed(preparation(unresolved))).toThrow('unresolved tool calls')
  })

  it('stores exact standard system text in the new seed for restart-safe reconstruction', () => {
    const standard: PortableAgentContextV1 = {
      ...context,
      source: { ...context.source, driver: { id: 'standard', version: '1' } },
      items: [
        { id: 'instruction', role: 'system', content: [{ kind: 'text', text: 'Keep {{source_variable}} literal.' }], provenance: { kind: 'instruction' } },
        ...context.items.slice(1),
      ],
    }
    const seed = buildStandardImportSeed(preparation(standard))
    expect(seed.systemInstruction).toBe('Keep {{source_variable}} literal.')
    expect(Session.create(targetId, structuredClone(seed.events)).requestHeader()?.system)
      .toBe('Keep {{source_variable}} literal.')
    expect(seed.instructions).toEqual([{
      kind: 'instruction', sourceItemId: 'instruction', role: 'system',
      content: [{ type: 'text', text: 'Keep {{source_variable}} literal.' }],
    }])
  })

  it('refuses standard instructions that cannot occupy the target system role', () => {
    const invalid: PortableAgentContextV1 = {
      ...context, source: { ...context.source, driver: { id: 'standard', version: '1' } },
    }
    expect(() => buildStandardImportSeed(preparation(invalid)))
      .toThrow('requires one plain-text system instruction')
  })
})
