import {
  SessionFormatError,
  snapshotSessionFormatArtifact,
} from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV2Header,
  assertReleasedV2PhysicalArtifact,
  restoreReleasedV2Artifact,
} from '@deepseek-ai/dsh-session-format-v1-to-v2'

/**
 * Validate the v3 header, including portable import ancestry.
 * @param header - decoded v3 logical header.
 */
export function assertReleasedV3Header(header: SessionFormatHeader): void {
  const { importLineage, ...base } = header
  if (header.version !== 3) throw new SessionFormatError('expected format v3 header')
  assertReleasedV2Header({ ...base, version: 2 })
  if (importLineage === undefined) return
  const candidate: unknown = importLineage
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new SessionFormatError('format v3 importLineage must be an object')
  }
  const lineage = importLineage as SessionFormatJsonObject
  if (Object.keys(lineage).length !== 3
    || typeof lineage['sourceSessionId'] !== 'string' || lineage['sourceSessionId'].length === 0
    || typeof lineage['sourceDriverId'] !== 'string' || lineage['sourceDriverId'].length === 0
    || typeof lineage['importId'] !== 'string' || lineage['importId'].length === 0
    || lineage['sourceSessionId'] === header.id
    || header.parentSession !== undefined || header.isSeeded) {
    throw new SessionFormatError('format v3 importLineage is invalid or combined with fork lineage')
  }
}

/**
 * Validate v3 physical event envelopes without freezing future event names.
 * @param artifact - complete decoded v3 artifact.
 */
export function assertReleasedV3PhysicalArtifact(artifact: SessionFormatArtifact): void {
  assertReleasedV3Header(artifact.header)
  assertReleasedV2PhysicalArtifact(asV2(artifact))
}

/**
 * Restore current event vocabulary while retaining the v3 header.
 * @param artifact - complete decoded v3 artifact.
 * @param knownEventTypes - event types understood by the installed Session package.
 * @returns the validated artifact.
 */
export function restoreReleasedV3Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV3Header(artifact.header)
  restoreReleasedV2Artifact(asV2(artifact), knownEventTypes)
  return artifact
}

function asV2(artifact: SessionFormatArtifact): SessionFormatArtifact {
  const { importLineage: _lineage, ...base } = artifact.header
  return snapshotSessionFormatArtifact({
    header: { ...base, version: 2 },
    inheritedEventCount: artifact.inheritedEventCount,
    events: artifact.events,
  }, 'v3 event validation through released v2 envelopes')
}
