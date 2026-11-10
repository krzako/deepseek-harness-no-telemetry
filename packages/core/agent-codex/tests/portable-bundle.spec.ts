import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isPortableAgentContextV1, type AgentDriverStateV1 } from '@deepseek-ai/dsh-agent'
import type { CodexContextSnapshotV2 } from '../src/context-snapshot.ts'
import { projectCodexPortableBundle } from '../src/portable-bundle.ts'
import type { CodexPortableCompactionAudit } from '../src/portable-compaction.ts'

const checkpoint = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2
const source: AgentDriverStateV1 = { version: 1, sessionId: 'session-1',
  driver: { id: 'codex', version: 'fork-abc' }, model: { provider: 'llm_proxy', id: 'glm' } }
const audits: CodexPortableCompactionAudit[] = checkpoint.compactions.map((compaction, index) => ({
  id: compaction.id, turn: index + 1, replacementHistory: compaction.replacementHistory,
  attempts: [{ requestEventId: `request-${index}`, settlementEventId: `result-${index}`,
    inputHistory: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `before-${index}` }] }],
    prompt: { compactionMetadata: { implementation: index === 0 ? 'responses' : 'responses_compaction_v2' } },
    result: { outputItems: [{ type: 'compaction_trigger' }] } }],
}))

describe('Codex portable Session bundle', () => {
  it('preserves active context, historical ancestry, driver route, and private checkpoint', () => {
    const bundle = projectCodexPortableBundle(source, checkpoint, audits, new Map())
    expect(bundle.context.source).toEqual(source)
    expect(bundle.context.effectiveItemIds).toEqual(['codex:response:0'])
    expect(bundle.context.compactions.map(compaction => ({ id: compaction.id, mode: compaction.mode,
      inputItemIds: compaction.inputItemIds, outputItemIds: compaction.outputItemIds }))).toEqual([
      { id: 'first', mode: 'local', inputItemIds: ['codex:response:3'], outputItemIds: ['codex:response:1'] },
      { id: 'second', mode: 'remote', inputItemIds: ['codex:response:4'], outputItemIds: ['codex:response:2'] },
    ])
    expect(isPortableAgentContextV1(bundle.context)).toBe(true)
    expect(bundle.privateSnapshot).toEqual({ version: 1, driverId: 'codex', driverRevision: 'fork-abc',
      schemaVersion: 2, context: checkpoint })
  })

  it('rejects a wrong driver, invalid checkpoint, and compaction mismatch', () => {
    expect(() => projectCodexPortableBundle({ ...source, driver: { id: 'standard', version: '1' } },
      checkpoint, audits, new Map())).toThrow('invalid driver state')
    expect(() => projectCodexPortableBundle(source, { ...checkpoint, effectiveHistorySha256: '0'.repeat(64) },
      audits, new Map())).toThrow('valid V2 checkpoint')
    expect(() => projectCodexPortableBundle(source, checkpoint, audits.slice(1), new Map()))
      .toThrow('differs from rollout projection')
  })
})
