import { describe, expect, it } from 'vitest'
import { releasedV2SessionFormatCodec, releasedV3SessionFormatCodec, sessionFormatV2ToV3 } from '../src/index.ts'

const header = {
  type: 'session', version: 3, id: 'imported', createdAt: 1,
  isSeeded: false, delegationDepth: 0,
  importLineage: { sourceSessionId: 'source', sourceDriverId: 'standard', importId: 'transfer' },
} as const

describe('v3 Session physical codec', () => {
  it('round-trips import ancestry while preserving event rows', () => {
    const rows = [{ type: 'agent/driver-selected', seq: 0, time: 2, data: { driverId: 'standard' } }]
    const decoded = releasedV3SessionFormatCodec.decodeArtifact(header, rows)
    expect(decoded.header.importLineage).toEqual(header.importLineage)
    expect(releasedV3SessionFormatCodec.encodeArtifact(decoded)).toEqual({ header, rows })
  })

  it('refuses malformed ancestry and keeps v2 strict', () => {
    expect(() => releasedV3SessionFormatCodec.decodeHeader({
      ...header, importLineage: { ...header.importLineage, extra: true },
    })).toThrow(/importLineage/)
    expect(() => releasedV3SessionFormatCodec.decodeHeader({
      ...header, importLineage: { ...header.importLineage, sourceSessionId: header.id },
    })).toThrow(/importLineage/)
    expect(() => releasedV2SessionFormatCodec.decodeHeader({ ...header, version: 2 }))
      .toThrow(/unexpected field importLineage/)
  })

  it('migrates a released v2 header and rows without ancestry', () => {
    const { importLineage: _lineage, type: _type, ...v3WithoutLineage } = header
    const v2 = releasedV2SessionFormatCodec.decodeArtifact({ type: 'session', ...v3WithoutLineage, version: 2 }, [])
    const migrated = sessionFormatV2ToV3.migrate(v2)
    expect(migrated.header).toEqual({ ...v3WithoutLineage, version: 3 })
  })
})
