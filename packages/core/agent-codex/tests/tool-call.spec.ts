import { describe, expect, it } from 'vitest'
import { codexToolCatalog } from '../src/tool-catalog.ts'
import { bindCodexToolCall } from '../src/tool-call.ts'

const schema = { name: 'lookup', description: 'Find a value', parameters: {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
} }

describe('Codex delegated tool-call admission', () => {
  it('maps a valid advertised call to a stable DSH ID', () => {
    const catalog = codexToolCatalog([schema])
    const params = { callId: 'call-1', tool: 'lookup', namespace: null, arguments: { query: 'hello' } }
    const first = bindCodexToolCall(params, 'dsh-session', 'codex-turn', catalog, schema)
    expect(first).toMatchObject({ codexCallId: 'call-1', name: 'lookup', arguments: { query: 'hello' } })
    expect(first.dshCallId).toMatch(/^codex_[0-9a-f]{64}$/)
    expect(bindCodexToolCall(params, 'dsh-session', 'codex-turn', catalog, schema).dshCallId)
      .toBe(first.dshCallId)
    expect(bindCodexToolCall({ ...params, callId: 'call-2' }, 'dsh-session', 'codex-turn', catalog, schema).dshCallId)
      .not.toBe(first.dshCallId)
  })

  it('rejects unadvertised, revoked, changed, namespaced, and invalid arguments', () => {
    const catalog = codexToolCatalog([schema])
    const params = { callId: 'call-1', tool: 'lookup', namespace: null, arguments: { query: 'hello' } }
    expect(() => bindCodexToolCall({ ...params, tool: 'new_tool' }, 's', 't', catalog, schema))
      .toThrow('not visible')
    expect(() => bindCodexToolCall(params, 's', 't', catalog, undefined)).toThrow('not visible')
    expect(() => bindCodexToolCall(params, 's', 't', catalog, { ...schema, description: 'changed' }))
      .toThrow('changed since turn admission')
    expect(() => bindCodexToolCall({ ...params, namespace: 'external' }, 's', 't', catalog, schema))
      .toThrow('namespaced')
    expect(() => bindCodexToolCall({ ...params, arguments: { query: 3 } }, 's', 't', catalog, schema))
      .toThrow('violate schema')
    expect(() => bindCodexToolCall({ ...params, arguments: [] }, 's', 't', catalog, schema))
      .toThrow('JSON object')
  })
})
