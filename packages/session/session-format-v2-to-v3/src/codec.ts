import {
  SessionFormatError,
  snapshotSessionFormatArtifact,
  snapshotSessionFormatJson,
} from '@deepseek-ai/dsh-session-format'
import type {
  EncodedSessionFormatArtifact,
  SessionFormatArtifact,
  SessionFormatCodec,
  SessionFormatHeader,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, assertReleasedV3PhysicalArtifact } from './validation.ts'

/** Frozen v3 physical codec: v2 event rows plus optional import ancestry in the header. */
export const releasedV3SessionFormatCodec = Object.freeze({
  version: 3,
  decodeHeader(value: unknown) {
    return decodeHeader(value)
  },
  decodeArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
    return decodeArtifact(headerValue, rowValues, false)
  },
  decodeRecoverableArtifact(headerValue: unknown, rowValues: readonly unknown[]) {
    return decodeArtifact(headerValue, rowValues, true)
  },
  encodeArtifact(artifact: SessionFormatArtifact) {
    assertReleasedV3PhysicalArtifact(artifact)
    const physical = releasedV2SessionFormatCodec.encodeArtifact(asV2(artifact))
    return Object.freeze({
      header: Object.freeze({ ...physical.header, version: 3, ...lineagePart(artifact.header) }),
      rows: physical.rows,
    })
  },
} satisfies SessionFormatCodec & {
  encodeArtifact(artifact: SessionFormatArtifact): EncodedSessionFormatArtifact
})

function decodeHeader(value: unknown): SessionFormatHeader {
  const physical = snapshotSessionFormatJson(value, 'released v3 physical header')
  if (typeof physical !== 'object' || physical === null || Array.isArray(physical)) {
    throw new SessionFormatError('released v3 physical header must be an object')
  }
  const record = physical as SessionFormatJsonObject
  if (record['version'] !== 3) throw new SessionFormatError('expected released v3 physical Session header')
  const { importLineage, ...v2Physical } = record
  const base = releasedV2SessionFormatCodec.decodeHeader({ ...v2Physical, version: 2 })
  const header = snapshotSessionFormatJson({ ...base, version: 3,
    ...(importLineage === undefined ? {} : { importLineage }),
  }, 'released v3 logical header') as SessionFormatHeader
  assertReleasedV3Header(header)
  return header
}

function decodeArtifact(
  headerValue: unknown,
  rowValues: readonly unknown[],
  recoverable: boolean,
): SessionFormatArtifact {
  const header = decodeHeader(headerValue)
  const physical = snapshotSessionFormatJson(headerValue, 'released v3 physical header') as SessionFormatJsonObject
  const { importLineage: _lineage, ...v2Physical } = physical
  const decoded = recoverable
    ? releasedV2SessionFormatCodec.decodeRecoverableArtifact({ ...v2Physical, version: 2 }, rowValues)
    : releasedV2SessionFormatCodec.decodeArtifact({ ...v2Physical, version: 2 }, rowValues)
  const artifact = snapshotSessionFormatArtifact({ ...decoded, header }, 'released v3 artifact')
  assertReleasedV3PhysicalArtifact(artifact)
  return artifact
}

function asV2(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const { importLineage: _lineage, ...base } = artifact.header
  return snapshotSessionFormatArtifact({
    ...artifact,
    header: { ...base, version: 2 },
  }, 'released v3 encoding through v2 event rows')
}

function lineagePart(header: SessionFormatHeader): SessionFormatJsonObject {
  return header.importLineage === undefined ? {} : { importLineage: header.importLineage }
}
