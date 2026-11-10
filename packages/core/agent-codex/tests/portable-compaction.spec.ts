import { createHash } from 'node:crypto'
import { admitCodexPortableJson } from '../src/portable-json.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isPortableAgentContextV1, type PortableCompactionV1 } from '@deepseek-ai/dsh-agent'
import { parseCodexAuditEventV1, type CodexAuditEventV1, type CodexAuditPayloadV1 } from '../src/audit-contract.ts'
import { codexJsonSha256, type CodexContextSnapshotV2 } from '../src/context-snapshot.ts'
import { projectCodexCompactionAncestry, projectCodexCompactionAncestryStream, resolveCodexInstalledCompactions,
  resolveCodexInstalledCompactionsStream, resolveCodexInstalledCompactionsWithStreamedHistory } from '../src/portable-compaction.ts'
import { projectCodexEffectiveHistory, projectCodexHistoricalItems } from '../src/portable-item.ts'

const checkpoint = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2
const inline = (value: JsonValue): CodexAuditPayloadV1 => ({ kind: 'inline', value })
const resolve = async (payload: CodexAuditPayloadV1): Promise<unknown> => {
  if (payload.kind !== 'inline') throw new Error('unexpected artifact')
  return payload.value
}

function fact(sequence: number, compactionId: string, data: Record<string, unknown>): CodexAuditEventV1 {
  return parseCodexAuditEventV1({
    version: 1, sequence, eventId: `event-${sequence}`, time: sequence,
    threadId: 'thread-1', turn: 1, compactionId, ...data,
  })
}

function chain(): CodexAuditEventV1[] {
  const first = checkpoint.compactions[0]!
  const second = checkpoint.compactions[1]!
  return [
    fact(1, first.id, { kind: 'compaction/request', reason: 'threshold', inputHistory: inline([{ type: 'message' }]),
      prompt: inline({ input: ['first attempt'], compactionMetadata: { implementation: 'responses' } }) }),
    fact(2, first.id, { kind: 'compaction/failure', message: 'retry', details: inline({ code: 'retryable' }) }),
    fact(3, first.id, { kind: 'compaction/request', reason: 'threshold', inputHistory: inline([{ type: 'message' }]),
      prompt: inline({ input: ['second attempt'], compactionMetadata: { implementation: 'responses' } }) }),
    fact(4, first.id, { kind: 'compaction/result', result: inline({ outputItems: ['first result'] }) }),
    fact(5, first.id, { kind: 'compaction/pending', effectiveHistory: inline([...first.replacementHistory]) }),
    fact(6, first.id, { kind: 'compaction/installed', effectiveHistory: inline([...first.replacementHistory]) }),
    fact(7, second.id, { kind: 'compaction/request', reason: 'manual', inputHistory: inline([]),
      prompt: inline({ input: ['second compaction'], compactionMetadata: { implementation: 'responses_compaction_v2' } }) }),
    fact(8, second.id, { kind: 'compaction/result', result: inline({ outputItems: ['second result'] }) }),
    fact(9, second.id, { kind: 'compaction/pending', effectiveHistory: inline([...second.replacementHistory]) }),
    fact(10, second.id, { kind: 'compaction/installed', effectiveHistory: inline([...second.replacementHistory]) }),
  ]
}

describe('Codex installed compaction audit', () => {
  it('streams every prompt, result and failed retry detail with the same canonical ancestry', async () => {
    const facts = chain()
    const resident = projectCodexCompactionAncestry(await resolveCodexInstalledCompactions(checkpoint, facts, resolve),
      projectCodexHistoricalItems(checkpoint, new Map()), 100, new Map())
    const groups = resolveCodexInstalledCompactionsWithStreamedHistory(checkpoint.compactions, facts, resolve,
      async function* (payload) {
        const value = await resolve(payload)
        if (!Array.isArray(value)) throw new Error('fixture history is not an array')
        yield* value as JsonValue[]
      }, async (payload, prompt) => {
        const data = Buffer.from(JSON.stringify(await resolve(payload)))
        return admitCodexPortableJson(async function* () { yield data },
          { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }, prompt)
      })
    const relations: PortableCompactionV1[] = []
    const items = []
    for await (const item of projectCodexCompactionAncestryStream(groups,
      projectCodexHistoricalItems(checkpoint, new Map()).compactionOutputs, 100, new Map(), value => relations.push(value))) {
      if (!('encoding' in item)) { items.push(item); continue }
      const chunks = []
      for await (const chunk of item.json.chunks) chunks.push(chunk)
      const data = Buffer.concat(chunks)
      expect(createHash('sha256').update(data).digest('hex')).toBe(item.json.sha256)
      expect(data.length).toBe(item.json.bytes)
      items.push({ id: item.id, role: item.role, provenance: item.provenance,
        content: [{ kind: 'opaque', namespace: item.namespace, value: JSON.parse(data.toString()) as unknown }] })
    }
    expect({ items, compactions: relations }).toEqual(resident)
  })

  it('resolves verified compactions incrementally with the same ordered audit groups', async () => {
    const resident = await resolveCodexInstalledCompactions(checkpoint, chain(), resolve)
    const streamed: unknown[] = []
    async function* source() {
      for (const group of checkpoint.compactions) yield group
    }
    for await (const group of resolveCodexInstalledCompactionsStream(source(), chain(), resolve)) {
      streamed.push(group)
    }
    expect(streamed).toEqual(resident)
  })

  it('validates installed histories through digests without resident resolution', async () => {
    const facts = chain()
    const histories = new Set(facts.flatMap(fact =>
      fact.kind === 'compaction/pending' || fact.kind === 'compaction/installed' ? [fact.effectiveHistory] : []))
    const digests: CodexAuditPayloadV1[] = []
    const streamedResolver = Object.assign(async (payload: CodexAuditPayloadV1) => {
      if (histories.has(payload)) throw new Error('unexpected resident history read')
      return resolve(payload)
    }, { historySha256: async (payload: CodexAuditPayloadV1) => {
      digests.push(payload)
      if (payload.kind !== 'inline') throw new Error('unexpected fixture artifact')
      return codexJsonSha256(payload.value)
    } })
    expect(await resolveCodexInstalledCompactions(checkpoint, facts, streamedResolver))
      .toEqual(await resolveCodexInstalledCompactions(checkpoint, facts, resolve))
    expect(digests).toEqual([...histories])

    for (const kind of ['compaction/pending', 'compaction/installed'] as const) {
      const target = facts.find(fact => fact.kind === kind)
      if (target?.kind !== kind) throw new Error('missing fixture history')
      const original = streamedResolver.historySha256
      const changed = Object.assign(streamedResolver, { historySha256: async (payload: CodexAuditPayloadV1) =>
        payload === target.effectiveHistory ? codexJsonSha256([]) : original(payload) })
      await expect(resolveCodexInstalledCompactions(checkpoint, facts, changed))
        .rejects.toThrow(`${kind.slice('compaction/'.length)} history differs`)
      streamedResolver.historySha256 = original
    }
    streamedResolver.historySha256 = async () => { throw new Error('artifact read failed') }
    await expect(resolveCodexInstalledCompactions(checkpoint, facts, streamedResolver)).rejects.toThrow('artifact read failed')
  })

  it('rejects a later malformed or duplicate group after yielding the first complete group', async () => {
    const first = checkpoint.compactions[0]!
    const second = checkpoint.compactions[1]!
    const groups = resolveCodexInstalledCompactionsStream([first, { ...second, replacementHistory: [] }], chain(), resolve)
    expect(await groups.next()).toMatchObject({ value: { id: first.id }, done: false })
    await expect(groups.next()).rejects.toThrow('Invalid or duplicate')

    const duplicates = resolveCodexInstalledCompactionsStream([first, first], chain(), resolve)
    expect(await duplicates.next()).toMatchObject({ value: { id: first.id }, done: false })
    await expect(duplicates.next()).rejects.toThrow('Invalid or duplicate')
  })

  it('keeps every failed and successful attempt with exact payloads in installation order', async () => {
    const groups = await resolveCodexInstalledCompactions(checkpoint, chain(), resolve)
    expect(groups).toEqual([
      { id: 'first', turn: 1, replacementHistory: checkpoint.compactions[0]!.replacementHistory,
        attempts: [
          { requestEventId: 'event-1', settlementEventId: 'event-2', inputHistory: [{ type: 'message' }],
            prompt: { input: ['first attempt'], compactionMetadata: { implementation: 'responses' } },
            failure: { message: 'retry', details: { code: 'retryable' } } },
          { requestEventId: 'event-3', settlementEventId: 'event-4', inputHistory: [{ type: 'message' }],
            prompt: { input: ['second attempt'], compactionMetadata: { implementation: 'responses' } },
            result: { outputItems: ['first result'] } },
        ] },
      { id: 'second', turn: 1, replacementHistory: checkpoint.compactions[1]!.replacementHistory,
        attempts: [{ requestEventId: 'event-7', settlementEventId: 'event-8', inputHistory: [],
          prompt: { input: ['second compaction'], compactionMetadata: { implementation: 'responses_compaction_v2' } },
          result: { outputItems: ['second result'] } }] },
    ])
  })

  it('rejects gaps, conflicting histories, overlapping requests, and a broken sequence', async () => {
    const facts = chain()
    await expect(resolveCodexInstalledCompactions(checkpoint, facts.filter(item => item.sequence !== 6), resolve))
      .rejects.toThrow('audit is incomplete')
    await expect(resolveCodexInstalledCompactions(checkpoint, facts.map(item => item.sequence === 5
      ? fact(5, 'first', { kind: 'compaction/pending', effectiveHistory: inline([]) }) : item), resolve))
      .rejects.toThrow('pending history differs')
    await expect(resolveCodexInstalledCompactions(checkpoint, [facts[0]!, facts[0]!, ...facts.slice(1)], resolve))
      .rejects.toThrow('not strictly increasing')
    await expect(resolveCodexInstalledCompactions(checkpoint, [facts[0]!,
      fact(2, 'first', { kind: 'compaction/request', reason: 'retry', inputHistory: inline([]), prompt: inline({}) }),
      ...facts.slice(2)], resolve)).rejects.toThrow('overlapping requests')
  })

  it('rejects a settlement from another turn and a malformed resolved artifact', async () => {
    const facts = chain()
    const wrongTurn = parseCodexAuditEventV1({ ...facts[3], turn: 2 })
    await expect(resolveCodexInstalledCompactions(checkpoint,
      facts.map(item => item.sequence === 4 ? wrongTurn : item), resolve)).rejects.toThrow('multiple threads or turns')
    let resolved = 0
    await expect(resolveCodexInstalledCompactions(checkpoint, facts,
      async payload => ++resolved === 1 ? 'not an array' : resolve(payload)))
      .rejects.toThrow('invalid request payload')
  })

  it('links local and remote retries to canonical input, prompt, result, and rollout output IDs', async () => {
    const audits = await resolveCodexInstalledCompactions(checkpoint, chain(), resolve)
    const effective = projectCodexEffectiveHistory(checkpoint, new Map())
    const historical = projectCodexHistoricalItems(checkpoint, new Map())
    const ancestry = projectCodexCompactionAncestry(audits, historical,
      effective.length + historical.items.length, new Map())
    expect(ancestry.compactions).toEqual([
      { id: 'first', mode: 'local', inputItemIds: ['codex:response:3'],
        outputItemIds: ['codex:response:1'],
        promptItemIds: ['codex:compaction:first:attempt:0:prompt', 'codex:compaction:first:attempt:1:prompt'],
        resultItemIds: ['codex:compaction:first:attempt:0:result', 'codex:compaction:first:attempt:1:result'] },
      { id: 'second', mode: 'remote', inputItemIds: [], outputItemIds: ['codex:response:2'],
        promptItemIds: ['codex:compaction:second:attempt:0:prompt'],
        resultItemIds: ['codex:compaction:second:attempt:0:result'] },
    ])
    expect(ancestry.items.find(item => item.id === 'codex:compaction:first:attempt:0:result')?.content)
      .toEqual([{ kind: 'opaque', namespace: 'codex.compaction.failure.v1',
        value: { message: 'retry', details: { code: 'retryable' } } }])
    expect(isPortableAgentContextV1({ version: 1,
      source: { version: 1, sessionId: 'session-1', driver: { id: 'codex', version: 'fork-abc' },
        model: { provider: 'llm_proxy', id: 'glm' } },
      items: [...effective, ...historical.items, ...ancestry.items],
      effectiveItemIds: effective.map(item => item.id), compactions: ancestry.compactions,
    })).toBe(true)
  })

  it('streams the same canonical ancestry and rejects missing or extra rollout outputs', async () => {
    const audits = await resolveCodexInstalledCompactions(checkpoint, chain(), resolve)
    const historical = projectCodexHistoricalItems(checkpoint, new Map())
    const firstResponseIndex = checkpoint.effectiveHistory.length + historical.items.length
    const resident = projectCodexCompactionAncestry(audits, historical, firstResponseIndex, new Map())
    const items: typeof resident.items[number][] = []
    const compactions: typeof resident.compactions[number][] = []
    for await (const item of projectCodexCompactionAncestryStream(audits, historical.compactionOutputs,
      firstResponseIndex, new Map(), compaction => compactions.push(compaction))) {
      if ('encoding' in item) throw new Error('resident fixture unexpectedly streamed')
      items.push(item)
    }
    expect({ items, compactions }).toEqual(resident)

    const missing = projectCodexCompactionAncestryStream(audits, historical.compactionOutputs.slice(0, 1),
      firstResponseIndex, new Map(), () => undefined)
    expect((await missing.next()).done).toBe(false)
    await expect(async () => { for await (const _item of missing) { /* consume */ } })
      .rejects.toThrow('no matching rollout output')
    await expect(async () => { for await (const _item of projectCodexCompactionAncestryStream(audits.slice(0, 1),
      historical.compactionOutputs, firstResponseIndex, new Map(), () => undefined)) { /* consume */ } })
      .rejects.toThrow('extra installation')
  })

  it('validates every retry history and projects the same ancestry from lazy readers', async () => {
    const facts = chain()
    const audits = await resolveCodexInstalledCompactions(checkpoint, facts, resolve)
    const historical = projectCodexHistoricalItems(checkpoint, new Map())
    const expected = projectCodexCompactionAncestry(audits, historical, 3, new Map())
    const reads = new Map<CodexAuditPayloadV1, number>()
    const readHistory = async function* (payload: CodexAuditPayloadV1) {
      reads.set(payload, (reads.get(payload) ?? 0) + 1)
      if (payload.kind !== 'inline' || !Array.isArray(payload.value)) throw new Error('invalid fixture history')
      yield* payload.value
    }
    const groups = resolveCodexInstalledCompactionsWithStreamedHistory(checkpoint.compactions, facts, resolve, readHistory)
    const items = []
    const compactions: PortableCompactionV1[] = []
    for await (const item of projectCodexCompactionAncestryStream(groups, historical.compactionOutputs,
      3, new Map(), relation => compactions.push(relation))) items.push(item)
    expect({ items, compactions }).toEqual(expected)
    expect([...reads.values()]).toEqual([1, 2, 2])
    const failedRetry = resolveCodexInstalledCompactionsWithStreamedHistory(checkpoint.compactions, facts, resolve,
      async function* () { throw new Error('failed retry has truncated history') })
    await expect(failedRetry.next()).rejects.toThrow('failed retry has truncated history')
  })

  it('closes a partially projected input and never publishes an incomplete relation', async () => {
    const audits = await resolveCodexInstalledCompactions(checkpoint, chain(), resolve)
    const first = audits[0]!
    const historical = projectCodexHistoricalItems(checkpoint, new Map())
    for (const fail of [false, true]) {
      let seen = 0
      let closed = false
      const input = async function* () {
        try {
          for (let index = 0; index < 1000; index++) {
            if (fail && index === 1) throw new Error('second read failed')
            seen++
            yield { type: 'message' }
          }
        } finally { closed = true }
      }
      const attempts = first.attempts.map((attempt, index) => ({ ...attempt,
        inputHistory: index === first.attempts.length - 1 ? input() : attempt.inputHistory }))
      const relations: PortableCompactionV1[] = []
      const projected = projectCodexCompactionAncestryStream([{ ...first, attempts }],
        historical.compactionOutputs.slice(0, 1), 3, new Map(), relation => relations.push(relation))
      for (let index = 0; index < first.attempts.length * 2; index++) await projected.next()
      expect(seen).toBe(0)
      expect((await projected.next()).value).toMatchObject({ id: 'codex:response:3' })
      expect(seen).toBe(1)
      if (fail) await expect(projected.next()).rejects.toThrow('second read failed')
      else await projected.return(undefined)
      expect(closed).toBe(true)
      expect(relations).toEqual([])
    }
  })

  it('refuses unsupported or conflicting implementation and unmatched rollout outputs', async () => {
    const audits = await resolveCodexInstalledCompactions(checkpoint, chain(), resolve)
    const historical = projectCodexHistoricalItems(checkpoint, new Map())
    expect(() => projectCodexCompactionAncestry([{ ...audits[0]!, attempts: [{ ...audits[0]!.attempts[0]!,
      prompt: { compactionMetadata: { implementation: 'other' } } }, ...audits[0]!.attempts.slice(1)] }, audits[1]!],
    historical, 3, new Map())).toThrow('no supported audited implementation')
    expect(() => projectCodexCompactionAncestry(audits,
      { ...historical, compactionOutputs: [...historical.compactionOutputs].reverse() }, 3, new Map()))
      .toThrow('no matching successful rollout output')
  })
})
