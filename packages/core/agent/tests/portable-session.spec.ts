import { describe, expect, it } from 'vitest'
import {
  assessPortableImportV1, isAgentDriverStateV1, isPortableAgentContextV1, isPrivateDriverSnapshotV1,
  type PortableAgentContextV1,
} from '../src/portable-session.ts'

const source = {
  version: 1,
  sessionId: 'session-1',
  driver: { id: 'codex', version: '1' },
  model: { provider: 'llm_proxy', id: 'glm' },
} as const

const context: PortableAgentContextV1 = {
  version: 1,
  source,
  items: [
    { id: 'user-1', role: 'user', content: [{ kind: 'text', text: 'hello' }], provenance: { kind: 'user' } },
    { id: 'call-1', role: 'assistant', content: [{ kind: 'tool-call', callId: 'tool-1', name: 'read', arguments: '{}' }], provenance: { kind: 'model' } },
    { id: 'result-1', role: 'tool', content: [{ kind: 'tool-result', callId: 'tool-1', content: [{ kind: 'text', text: 'ok' }], isError: false }], provenance: { kind: 'tool' } },
    { id: 'summary-1', role: 'system', content: [{ kind: 'text', text: 'summary' }], provenance: { kind: 'compaction' } },
  ],
  effectiveItemIds: ['summary-1'],
  compactions: [{ id: 'compact-1', mode: 'local', inputItemIds: ['user-1', 'call-1', 'result-1'], outputItemIds: ['summary-1'], promptItemIds: [], resultItemIds: ['summary-1'] }],
}

describe('portable Agent Session schemas', () => {
  it('accepts a full history while retaining an effective post-compaction projection', () => {
    expect(isAgentDriverStateV1(source)).toBe(true)
    expect(isPortableAgentContextV1(context)).toBe(true)
  })

  it('rejects a missing effective item and duplicate history identity', () => {
    expect(isPortableAgentContextV1({ ...context, effectiveItemIds: ['missing'] })).toBe(false)
    expect(isPortableAgentContextV1({ ...context, items: [...context.items, context.items[0]] })).toBe(false)
  })

  it('rejects unknown fields, unsupported versions and non-JSON private state', () => {
    expect(isAgentDriverStateV1({ ...source, version: 2 })).toBe(false)
    expect(isPortableAgentContextV1({ ...context, silentDrop: true })).toBe(false)
    expect(isPrivateDriverSnapshotV1({ version: 1, driverId: 'codex', driverRevision: 'fork-abc', schemaVersion: 1, context: { fn: () => 1 } })).toBe(false)
  })

  it('reports a same-driver private restore and a cross-driver portable restore', () => {
    const target = {
      driverId: 'codex', supportedContextVersions: [1], supportedPrivateSnapshotVersions: [1], supportedPrivateRevisions: ['fork-abc'],
      supportedOpaqueNamespaces: [], availableModels: [{ provider: 'llm_proxy', id: 'glm' }],
    }
    const snapshot = { version: 1 as const, driverId: 'codex', driverRevision: 'fork-abc', schemaVersion: 1, context: [] }
    expect(assessPortableImportV1(context, target, source.model, snapshot).fidelity).toBe('same-driver')
    const other = assessPortableImportV1(context, { ...target, driverId: 'standard' }, source.model, snapshot)
    expect(other.fidelity).toBe('portable')
    expect(other.issues.map(issue => issue.code)).toEqual(['driver-changed', 'private-snapshot'])
    expect(assessPortableImportV1(context, { ...target, supportedPrivateRevisions: ['fork-new'] }, source.model, snapshot).fidelity).toBe('portable')
  })

  it('blocks opaque content unsupported by a target driver', () => {
    const withOpaque: PortableAgentContextV1 = {
      ...context,
      items: [{ ...context.items[0]!, content: [{ kind: 'opaque', namespace: 'vendor.audio', value: { url: 'x' } }] }],
      effectiveItemIds: ['user-1'],
      compactions: [],
    }
    expect(assessPortableImportV1(withOpaque, {
      driverId: 'standard', supportedContextVersions: [1], supportedPrivateSnapshotVersions: [], supportedPrivateRevisions: [],
      supportedOpaqueNamespaces: [], availableModels: [],
    }, source.model).fidelity).toBe('unsupported')
  })

  it('distinguishes opaque active context from non-active compaction provenance', () => {
    const withProvenance: PortableAgentContextV1 = { ...context, items: [...context.items,
      { id: 'audit-1', role: 'assistant', content: [{ kind: 'opaque', namespace: 'codex.compaction.prompt.v1',
        value: { input: ['complete prompt'] } }], provenance: { kind: 'compaction' } },
    ] }
    const target = { driverId: 'codex', supportedContextVersions: [1], supportedPrivateSnapshotVersions: [2],
      supportedPrivateRevisions: ['fork-abc'], supportedOpaqueNamespaces: [],
      availableModels: [{ provider: 'llm_proxy', id: 'glm' }] }
    const snapshot = { version: 1 as const, driverId: 'codex', driverRevision: 'fork-abc',
      schemaVersion: 2, context: { version: 2 } }
    expect(assessPortableImportV1(withProvenance, target, source.model, snapshot))
      .toEqual({ fidelity: 'same-driver', issues: [] })
    expect(assessPortableImportV1({ ...withProvenance, effectiveItemIds: ['audit-1'] },
      target, source.model, snapshot)).toEqual({ fidelity: 'same-driver', issues: [] })
    const changed = assessPortableImportV1(withProvenance, { ...target, driverId: 'standard' }, source.model, snapshot)
    expect(changed.fidelity).toBe('portable')
    expect(changed.issues.map(issue => [issue.code, issue.severity])).toEqual([
      ['driver-changed', 'warning'], ['opaque-content', 'warning'], ['private-snapshot', 'warning'],
    ])
    expect(changed.issues[1]?.detail).toContain('Inactive provenance namespace codex.compaction.prompt.v1')
    const withoutPrivate = assessPortableImportV1(withProvenance, target, source.model)
    expect(withoutPrivate.fidelity).toBe('portable')
    expect(withoutPrivate.issues.map(issue => issue.severity)).toEqual(['warning'])
    expect(assessPortableImportV1({ ...withProvenance, effectiveItemIds: ['audit-1'] },
      { ...target, driverId: 'standard' }, source.model, snapshot).issues)
      .toContainEqual({ severity: 'error', code: 'opaque-content',
        detail: 'Unsupported active content namespace codex.compaction.prompt.v1' })
  })
})
