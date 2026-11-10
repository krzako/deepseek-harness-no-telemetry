import { createHash } from 'node:crypto'
import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { verifyDshArchiveInventory } from '../src/manifest.ts'
import { completeDshArchiveManifestV1, measureDshArchiveEntry } from '../src/manifest-stream.ts'

const payloads = {
  'session.v3.jsonl': Buffer.from('ż\n'),
  'agent/driver.json': Buffer.from('{}'),
  'agent/context.json': Buffer.from('{"text":"pełna treść"}'),
  'files/data.bin': Uint8Array.of(0, 255, 1),
}
const manifest = completeDshArchiveManifestV1({
  rootSessionId: 'source', sessionLogPath: 'session.v3.jsonl',
  driverStatePath: 'agent/driver.json', contextPath: 'agent/context.json',
  privateSnapshotPath: null,
  workspace: { sourceCwd: null, fingerprint: null, snapshot: null },
}, [
  measureDshArchiveEntry({ path: 'session.v3.jsonl', data: payloads['session.v3.jsonl'] }, 'session-log').receipt(),
  measureDshArchiveEntry({ path: 'agent/driver.json', data: payloads['agent/driver.json'] }, 'driver-state').receipt(),
  measureDshArchiveEntry({ path: 'agent/context.json', data: payloads['agent/context.json'] }, 'portable-context').receipt(),
  measureDshArchiveEntry({ path: 'files/data.bin', data: payloads['files/data.bin'] }, 'attachment').receipt(),
])

function inventory(files: Record<string, Uint8Array>) {
  return Object.entries(files).map(([path, bytes]) => ({
    path, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
  }))
}

describe('portable archive inventory verification', () => {
  it('verifies measured decompressed payloads independent of entry order', () => {
    const decoded = unzipSync(zipSync({ ...payloads, 'manifest.json': Buffer.from(JSON.stringify(manifest)) }))
    const parsed: unknown = JSON.parse(Buffer.from(decoded['manifest.json']!).toString('utf8'))
    delete decoded['manifest.json']
    expect(verifyDshArchiveInventory(parsed, inventory(decoded).reverse())).toEqual(manifest)
  })

  it('rejects truncated and same-size changed payloads even when the manifest is unchanged', () => {
    for (const data of [Uint8Array.of(0, 255), Uint8Array.of(0, 255, 2)]) {
      const decoded = unzipSync(zipSync({ ...payloads, 'files/data.bin': data }))
      expect(() => verifyDshArchiveInventory(manifest, inventory(decoded))).toThrow('hash or size differs at files/data.bin')
    }
  })

  it('rejects missing and undeclared payloads rather than ignoring them', () => {
    const receipts = inventory(payloads)
    expect(() => verifyDshArchiveInventory(manifest, receipts.slice(0, -1))).toThrow('missing archive payload files/data.bin')
    for (const path of ['extra.bin', '../outside', '/absolute', 'manifest.json']) {
      expect(() => verifyDshArchiveInventory(manifest, [...receipts, { ...receipts[0]!, path }]))
        .toThrow(`undeclared archive payload ${path}`)
    }
  })

  it('rejects duplicate payload names even when their measured bytes agree', () => {
    const receipts = inventory(payloads)
    expect(() => verifyDshArchiveInventory(manifest, [...receipts, receipts[0]!]))
      .toThrow('duplicate archive payload session.v3.jsonl')
  })

  it('validates the manifest before consuming the inventory and propagates read failure', () => {
    function* failed() { yield* inventory(payloads); throw new Error('incomplete archive read') }
    expect(() => verifyDshArchiveInventory({ ...manifest, version: 99 }, failed())).toThrow('invalid archive manifest')
    expect(() => verifyDshArchiveInventory(manifest, failed())).toThrow('incomplete archive read')
    expect(() => verifyDshArchiveInventory({ ...manifest, contextPath: '../outside' }, inventory(payloads)))
      .toThrow('invalid archive manifest')
  })
})
