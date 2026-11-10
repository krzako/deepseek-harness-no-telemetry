import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  codexJsonSha256, codexPrivateSnapshot, isCodexContextSnapshotV1, isCodexContextSnapshotV2,
  type CodexContextSnapshotV1, type CodexContextSnapshotV2,
} from '../src/context-snapshot.ts'

const snapshot: CodexContextSnapshotV1 = {
  version: 1,
  runtimeRevision: 'fork-abc',
  items: [{ id: 'one', value: { type: 'message', content: [] } }],
  effectiveItemIds: ['one'],
  compactions: [],
  promptConfig: {
    model: 'glm', provider: 'llm_proxy', systemInstructions: 'system', developerInstructions: 'developer',
    reasoningEffort: null, toolSchemas: [],
  },
}

/** Byte-for-byte serde_json output of the fork's dsh_context_snapshot fixture. */
const checkpoint = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2

describe('Codex private checkpoint', () => {
  it('matches Rust for floats, large integers, negative zero, and UTF-8 key order', () => {
    const numeric = {
      '10': 1e21,
      '2': -0,
      nested: [1.0, 1e-7, 9_007_199_254_740_993],
      '\ue000': 'private-use',
      '😀': 'supplementary',
    }
    expect(codexJsonSha256(numeric)).toBe('b4b42ba5e7880e91469e8b01bdabf4a33bb05ed83b6583078e07af8e4cde2a9f')
  })

  it('validates and wraps a full next-request context', () => {
    expect(isCodexContextSnapshotV1(snapshot)).toBe(true)
    expect(codexPrivateSnapshot(snapshot).driverId).toBe('codex')
  })

  it('rejects a missing effective item and non-JSON native item', () => {
    expect(isCodexContextSnapshotV1({ ...snapshot, effectiveItemIds: ['missing'] })).toBe(false)
    expect(isCodexContextSnapshotV1({ ...snapshot, items: [{ id: 'one', value: { undefined: undefined } }] })).toBe(false)
  })

  it('accepts fork V2 history and durable compaction references without claiming replay', () => {
    expect(isCodexContextSnapshotV2(checkpoint)).toBe(true)
    expect(codexPrivateSnapshot(checkpoint)).toEqual({
      version: 1, driverId: 'codex', driverRevision: 'fork-abc', schemaVersion: 2, context: checkpoint,
    })
  })

  it('rejects missing, duplicated, or corrupted V2 references', () => {
    expect(isCodexContextSnapshotV2({ ...checkpoint, effectiveHistorySha256: 'bad' })).toBe(false)
    expect(isCodexContextSnapshotV2({ ...checkpoint, rollout: [undefined] })).toBe(false)
    expect(isCodexContextSnapshotV2({ ...checkpoint, contextConfig: { schemaVersion: 3 } })).toBe(false)
    expect(isCodexContextSnapshotV2({ ...checkpoint, compactions: [checkpoint.compactions[0], checkpoint.compactions[0]] })).toBe(false)
    expect(isCodexContextSnapshotV2({ ...checkpoint, compactions: [{ ...checkpoint.compactions[0], id: 'other' }, checkpoint.compactions[1]] })).toBe(false)
    expect(isCodexContextSnapshotV2({ ...checkpoint, effectiveHistory: [] })).toBe(false)
    expect(isCodexContextSnapshotV2({ ...checkpoint, rollout: [] })).toBe(false)
    expect(isCodexContextSnapshotV2({ ...checkpoint, compactions: [] })).toBe(false)
  })
})
