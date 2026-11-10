import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { admitCodexPortableJson, codexPortableFailureJson } from '../src/portable-json.ts'

function source(text: string | Buffer) {
  const data = Buffer.isBuffer(text) ? text : Buffer.from(text)
  const read = async function* () {
    for (let offset = 0; offset < data.length; offset += 127) yield data.subarray(offset, offset + 127)
  }
  const receipt = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  return { read, receipt, data }
}

async function bytes(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result = []
  for await (const chunk of chunks) result.push(chunk)
  return Buffer.concat(result)
}

describe('opaque Codex JSON admission', () => {
  it('preserves exact large Unicode JSON and reads only audited top-level implementation', async () => {
    const input = source(JSON.stringify({ text: 'żółć'.repeat(50000), nested: { compactionMetadata: { implementation: 'wrong' } },
      compactionMetadata: { implementation: 'responses_compaction_v2' } }))
    const value = await admitCodexPortableJson(input.read, input.receipt, true)
    expect(value.mode).toBe('remote')
    expect(await bytes(value.json.chunks)).toEqual(input.data)
    expect(value.json).toMatchObject(input.receipt)
  })

  it.each(['', '{', '[] []', 'null trailing', '{"a":}', '"bad\nstring"', '[NaN]', '[1e999]', '[-0]', '[-1e-999]'])
  ('refuses malformed or non-lossless JSON %s', async (text) => {
    const input = source(text)
    await expect(admitCodexPortableJson(input.read, input.receipt, false)).rejects.toThrow()
  })

  it('refuses invalid UTF-8 instead of silently replacing bytes', async () => {
    const input = source(Buffer.from([34, 0xff, 34]))
    await expect(admitCodexPortableJson(input.read, input.receipt, false)).rejects.toThrow()
  })

  it.each(['null', '[]', '"responses"', '{}', '{"nested":{"compactionMetadata":{"implementation":"responses"}}}',
    '{"compactionMetadata":{"implementation":"responses"},"compactionMetadata":{}}',
    '{"compactionMetadata":{"implementation":"responses","implementation":null}}',
    '{"compactionMetadata":{"implementation":{"value":"responses"}}}'])
  ('refuses missing or replaced implementation %s', async (text) => {
    const input = source(text)
    await expect(admitCodexPortableJson(input.read, input.receipt, true)).rejects.toThrow('supported audited implementation')
  })

  it('honors the last duplicate metadata value, as JSON.parse does', async () => {
    const input = source('{"compactionMetadata":null,"compactionMetadata":{"implementation":"wrong","implementation":"responses"}}')
    expect((await admitCodexPortableJson(input.read, input.receipt, true)).mode).toBe('local')
  })

  it('matches binary64 admission for rounding boundaries and arbitrarily long numeric scalars', async () => {
    const midpoint = (5n ** 1075n).toString().padStart(1075, '0')
    const overflow = 2n ** 1024n - 2n ** 970n
    const values = ['0', '1e2', '-2.5', '0e999999999999999999999999', '1e-9999',
      `${overflow - 1n}`, `${overflow}`, `-0.${midpoint}`, `-0.${midpoint}${'0'.repeat(4000)}1`,
      `1${'0'.repeat(10000)}e-10000`, `-0.${'0'.repeat(10000)}1e10001`,
      `-1e-${'0'.repeat(10000)}3`, `1e${'9'.repeat(10000)}`]
    for (const text of values) {
      const input = source(text)
      const parsed = Number(text)
      const result = admitCodexPortableJson(input.read, input.receipt, false)
      if (Number.isFinite(parsed) && !Object.is(parsed, -0)) await expect(result).resolves.toMatchObject({ encoding: 'codex-json' })
      else await expect(result).rejects.toThrow('not lossless JSON')
    }
  })

  it('wraps full failure details with a receipt covering exact wrapper bytes', async () => {
    const input = source(' { "details": [1e2, "żółć"] } ')
    const details = await admitCodexPortableJson(input.read, input.receipt, false)
    const wrapped = await codexPortableFailureJson('cancelled\n"quoted"', details)
    const data = await bytes(wrapped.json.chunks)
    expect(JSON.parse(data.toString())).toEqual({ message: 'cancelled\n"quoted"', details: { details: [100, 'żółć'] } })
    expect(wrapped.json.bytes).toBe(data.length)
    expect(wrapped.json.sha256).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it('propagates EOF reader failure before admitting a payload and closes malformed sources', async () => {
    const input = source('{}')
    let closed = false
    const failed = async function* () { try { yield input.data; throw new Error('receipt mismatch') } finally { closed = true } }
    await expect(admitCodexPortableJson(failed, input.receipt, false)).rejects.toThrow('receipt mismatch')
    expect(closed).toBe(true)
    closed = false
    const malformed = async function* () { try { yield Buffer.from('!'); yield input.data } finally { closed = true } }
    await expect(admitCodexPortableJson(malformed, input.receipt, false)).rejects.toThrow()
    expect(closed).toBe(true)
  })
})
