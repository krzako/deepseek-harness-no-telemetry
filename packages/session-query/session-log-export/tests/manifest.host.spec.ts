import { describe, expect, it } from 'vitest'
import { isDshSessionArchiveManifestV1 } from '../src/manifest.ts'

const digest = 'a'.repeat(64)
const manifest = {
  version: 1,
  rootSessionId: 'session-1',
  sessionLogPath: 'session.v2.jsonl',
  driverStatePath: 'agent/driver.json',
  contextPath: 'agent/context.json',
  privateSnapshotPath: null,
  entries: [
    { path: 'session.v2.jsonl', kind: 'session-log', bytes: 200, sha256: digest },
    { path: 'agent/driver.json', kind: 'driver-state', bytes: 50, sha256: digest },
    { path: 'agent/context.json', kind: 'portable-context', bytes: 100, sha256: digest },
  ],
  workspace: { sourceCwd: '/project', fingerprint: digest, snapshot: null },
} as const

describe('DSH archive manifest', () => {
  it('accepts an archive without a workspace snapshot', () => {
    expect(isDshSessionArchiveManifestV1(manifest)).toBe(true)
  })

  it('accepts versioned fingerprints and explicit unavailability without reinterpreting legacy digests', () => {
    expect(isDshSessionArchiveManifestV1({ ...manifest,
      workspace: { ...manifest.workspace, fingerprintAlgorithm: 'dsh-workspace-content-v1' } })).toBe(true)
    expect(isDshSessionArchiveManifestV1({ ...manifest,
      workspace: { ...manifest.workspace, fingerprint: null, fingerprintUnavailable: 'missing' } })).toBe(true)
    for (const workspace of [
      { ...manifest.workspace, fingerprintAlgorithm: 'unknown' },
      { ...manifest.workspace, fingerprintAlgorithm: 'dsh-workspace-content-v1', fingerprint: null },
      { ...manifest.workspace, fingerprintUnavailable: 'missing' },
      { ...manifest.workspace, fingerprint: null, fingerprintUnavailable: 'invented' },
      { ...manifest.workspace, fingerprintAlgorithm: 'dsh-workspace-content-v1', fingerprintUnavailable: 'missing' },
    ]) expect(isDshSessionArchiveManifestV1({ ...manifest, workspace })).toBe(false)
  })

  it('rejects path traversal, duplicate paths, and missing required payloads', () => {
    expect(isDshSessionArchiveManifestV1({ ...manifest, contextPath: '../outside' })).toBe(false)
    expect(isDshSessionArchiveManifestV1({ ...manifest, entries: [...manifest.entries, manifest.entries[0]] })).toBe(false)
    expect(isDshSessionArchiveManifestV1({ ...manifest, entries: manifest.entries.slice(0, 2) })).toBe(false)
  })

  it('accepts an empty snapshot and confines any workspace entries to its prefix', () => {
    const workspace = { ...manifest.workspace, snapshot: { prefix: 'workspace', complete: true } }
    expect(isDshSessionArchiveManifestV1({ ...manifest, workspace })).toBe(true)
    expect(isDshSessionArchiveManifestV1({ ...manifest, workspace, entries: [
      ...manifest.entries, { path: 'workspace/src/index.ts', kind: 'workspace', bytes: 1, sha256: digest },
    ] })).toBe(true)
    expect(isDshSessionArchiveManifestV1({ ...manifest, workspace, entries: [
      ...manifest.entries, { path: 'other/index.ts', kind: 'workspace', bytes: 1, sha256: digest },
    ] })).toBe(false)
  })
  it('validates the complete directory inventory including empty directories', () => {
    const candidate = (directories: unknown) => ({ ...manifest, workspace: { ...manifest.workspace,
      snapshot: { prefix: 'workspace', complete: true, directories } }, entries: [...manifest.entries,
      { path: 'workspace/src/file', kind: 'workspace', bytes: 0, sha256: digest }] })
    expect(isDshSessionArchiveManifestV1(candidate(['workspace/src', 'workspace/empty', 'workspace/empty/nested']))).toBe(true)
    for (const directories of [null, [], ['../escape'], ['workspace'], ['other/dir'], ['workspace/src', 'workspace/src'],
      ['workspace/src/file'], ['workspace/src', 'workspace/empty/nested'], ['workspace/src', 'workspace/src/file/subdir']]) {
      expect(isDshSessionArchiveManifestV1(candidate(directories))).toBe(false)
    }
  })

})
