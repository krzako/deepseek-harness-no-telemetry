import {
  defineSessionFormatMigration,
  snapshotSessionFormatArtifact,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV2Header,
  assertReleasedV2PhysicalArtifact,
} from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { assertReleasedV3Header, assertReleasedV3PhysicalArtifact } from './validation.ts'

/** Adjacent migration preserving v2 events and adding the v3 header generation. */
export const sessionFormatV2ToV3 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v2-to-v3',
  fromVersion: 2,
  toVersion: 3,
  migrateHeader(header) {
    assertReleasedV2Header(header)
    return { ...header, version: 3 }
  },
  migrate(source) {
    assertReleasedV2PhysicalArtifact(source)
    const target = snapshotSessionFormatArtifact({
      ...source,
      header: { ...source.header, version: 3 },
    }, 'v2-to-v3 target')
    assertReleasedV3PhysicalArtifact(target)
    return target
  },
  validateTarget: assertReleasedV3PhysicalArtifact,
  validateTargetHeader: assertReleasedV3Header,
})
