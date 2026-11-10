/** Portable Session entries share the existing ZIP stream and end with a verified manifest. */

import { createHash } from 'node:crypto'
import {
  isAgentDriverStateV1, isPortableAgentContextV1, isPrivateDriverSnapshotV1,
  type PortableAgentBundleV1, type PortableAgentStreamBundleV1,
  type PortablePrivateSnapshotStreamV1,
  type PortableContentBlockV1,
} from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import type { DshArchiveEntryV1 } from './manifest.ts'
import { completeDshArchiveManifestV1, createDshArchiveResourceBudget, measureDshArchiveEntry,
  type DshArchiveResourcePolicy } from './manifest-stream.ts'
import { portableContextJsonStream, portableJsonStream } from './json-stream.ts'
import type { DshWorkspaceExport } from './workspace-export.ts'
import { fingerprintDshWorkspace } from './workspace-fingerprint.ts'
import {
  fileEntryPath, mediaEntryPath, SESSION_LOG_FILENAME, sessionLogZipEntries, flushLiveSessionLog, readSessionLogText,
  type SessionLogExportReady, type SessionLogZipEntry,
} from './archive.ts'

const DRIVER_PATH = 'agent/driver.json'
const CONTEXT_PATH = 'agent/context.json'
const PRIVATE_PATH = 'agent/private-snapshot.json'

function streamed(bundle: PortableAgentBundleV1 | PortableAgentStreamBundleV1): bundle is PortableAgentStreamBundleV1 {
  return asyncIterable(bundle.context.items)
}

function asyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value
}

function streamedPrivate(value: unknown): value is PortablePrivateSnapshotStreamV1 {
  return value !== null && typeof value === 'object' && 'contextJson' in value
}

async function* privateSnapshotJsonStream(snapshot: PortablePrivateSnapshotStreamV1): AsyncGenerator<Uint8Array> {
  const header = JSON.stringify({ version: snapshot.version, driverId: snapshot.driverId,
    driverRevision: snapshot.driverRevision, schemaVersion: snapshot.schemaVersion })
  yield Buffer.from(`${header.slice(0, -1)},"context":`)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of snapshot.contextJson) {
    bytes += chunk.byteLength
    if (!Number.isSafeInteger(bytes) || bytes > snapshot.contextBytes) {
      throw new Error('session export: private checkpoint exceeded its declared size')
    }
    hash.update(chunk)
    yield chunk
  }
  if (bytes !== snapshot.contextBytes || hash.digest('hex') !== snapshot.contextSha256) {
    throw new Error('session export: private checkpoint hash or size differs')
  }
  yield Buffer.from('}')
}

function entryKind(path: string): DshArchiveEntryV1['kind'] {
  if (path === SESSION_LOG_FILENAME || /^subagents\/[^/]+\/session\.v\d+\.jsonl$/u.test(path)) return 'session-log'
  if (path.startsWith('media/') || path.startsWith('files/') || path.startsWith('audit/')) return 'attachment'
  throw new Error(`session export: unrecognized archive entry ${path}`)
}

/**
 * Validate resident exports and streamed metadata before any ZIP bytes are sent;
 * stream items and references are checked as their entry is consumed.
 * @param bundle - source port's canonical context and optional private checkpoint.
 * @param sessionId - addressed root Session.
 * @param driverId - driver committed in that Session's log.
 */
export function validatePortableArchiveBundle(
  bundle: PortableAgentBundleV1 | PortableAgentStreamBundleV1,
  sessionId: SessionId,
  driverId: string,
): void {
  const stream = streamed(bundle)
  const version: unknown = bundle.context.version
  if (!(stream
    ? version === 1 && isAgentDriverStateV1(bundle.context.source)
      && asyncIterable(bundle.context.effectiveItemIds)
      && asyncIterable(bundle.context.compactions)
    : isPortableAgentContextV1(bundle.context))
    || bundle.context.source.sessionId !== sessionId || bundle.context.source.driver.id !== driverId
    || (bundle.privateSnapshot !== undefined
      && (!(streamedPrivate(bundle.privateSnapshot)
        ? asyncIterable(bundle.privateSnapshot.contextJson)
          && Number.isSafeInteger(bundle.privateSnapshot.contextBytes) && bundle.privateSnapshot.contextBytes > 0
          && /^[0-9a-f]{64}$/u.test(bundle.privateSnapshot.contextSha256)
          && isPrivateDriverSnapshotV1({ version: bundle.privateSnapshot.version,
            driverId: bundle.privateSnapshot.driverId, driverRevision: bundle.privateSnapshot.driverRevision,
            schemaVersion: bundle.privateSnapshot.schemaVersion, context: null })
        : isPrivateDriverSnapshotV1(bundle.privateSnapshot))
        || bundle.privateSnapshot.driverId !== driverId))) {
    throw new Error('session export: source driver returned an incompatible portable context')
  }
}

/**
 * Read the durable driver selection from the already-loaded root JSONL.
 * @param rootContent - validated canonical Session log text.
 * @returns one committed driver id; missing or conflicting selections reject.
 */
export function exportDriverId(rootContent: string): string {
  let driverId: string | undefined
  let start = rootContent.indexOf('\n') + 1
  while (start > 0 && start < rootContent.length) {
    const end = rootContent.indexOf('\n', start)
    if (end < 0) throw new Error('session export: unterminated Session log')
    const line = rootContent.slice(start, end)
    start = end + 1
    if (line.length === 0) continue
    const event = JSON.parse(line) as { type?: unknown; data?: { driverId?: unknown; version?: unknown } }
    if (event.type !== 'agent/driver-selected') continue
    const selected = event.data?.driverId
    if (event.data?.version !== 1 || typeof selected !== 'string' || selected.length === 0
      || driverId !== undefined) throw new Error('session export: invalid durable driver selection')
    driverId = selected
  }
  if (driverId === undefined) throw new Error('session export: no durable driver selection')
  return driverId
}

/** Read the workspace recorded in the flushed source log.
 * @param rootContent - serialized log with its validated header first.
 * @returns recorded cwd or null when not selected.
 */
export function sourceCwd(rootContent: string): string | null {
  const firstLine = rootContent.slice(0, rootContent.indexOf('\n'))
  const header = JSON.parse(firstLine) as { cwd?: unknown }
  return typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null
}

async function verifyStableLogs(
  deps: SessionLogExportReady,
  sessionId: SessionId,
  logs: ReadonlyMap<SessionId, string>,
  includeDescendants: boolean,
  signal?: AbortSignal,
): Promise<void> {
  for (const [id, digest] of logs) {
    await flushLiveSessionLog(deps, id, signal)
    const content = await readSessionLogText(deps.sessionPersistence, id, signal)
    signal?.throwIfAborted()
    if (content === undefined || createHash('sha256').update(content).digest('hex') !== digest) {
      throw new Error('session export: Session log changed during portable streaming; retry the download')
    }
  }
  if (includeDescendants) {
    const lineage = await deps.sessionQuery.traceSession(sessionId, signal)
    const ids = new Set<SessionId>([sessionId])
    const visit = (nodes: readonly SessionLineageNode[]): void => {
      for (const node of nodes) {
        ids.add(node.session.header.id)
        visit(node.descendants)
      }
    }
    visit(lineage.descendants)
    if (ids.size !== logs.size || [...ids].some(id => !logs.has(id))) {
      throw new Error('session export: Session descendants changed during portable streaming; retry the download')
    }
  }
  signal?.throwIfAborted()
}

const MEDIA_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}

function portableAttachmentChecker(
  receipts: readonly DshArchiveEntryV1[],
): (blocks: readonly PortableContentBlockV1[]) => void {
  const paths = new Set(receipts.filter(entry => entry.kind === 'attachment').map(entry => entry.path))
  const filePaths = [...paths].filter(path => path.startsWith('files/'))
  const hasAttachment = (block: Extract<PortableContentBlockV1, { readonly kind: 'attachment' }>): boolean => {
    const supported = Object.hasOwn(MEDIA_EXTENSIONS, block.mediaType)
    if (supported) return paths.has(mediaEntryPath(block.attachmentId, block.mediaType as keyof typeof MEDIA_EXTENSIONS))
    if (block.mediaType.startsWith('image/')) return false
    if (block.name !== undefined) return paths.has(fileEntryPath(block.attachmentId, block.name))
    const digest = block.attachmentId.replace(/^sha256:/u, '')
    const prefix = `files/${digest.slice(0, 2)}/${digest}/`
    return filePaths.some(path => path.startsWith(prefix))
  }
  const visit = (blocks: readonly PortableContentBlockV1[]): void => {
    for (const block of blocks) {
      if (block.kind === 'attachment' && !hasAttachment(block)) {
        throw new Error(`session export: portable context attachment ${block.attachmentId} is missing from ZIP`)
      }
      if (block.kind === 'tool-result') visit(block.content)
    }
  }
  return visit
}

/**
 * Yield every log/attachment and source-driver state, then a final manifest.
 * The ZIP writer must completely consume each yielded entry before requesting
 * the next; an interrupted streamed entry has no receipt and fails the archive.
 * Before the final manifest, every included log is flushed and compared with
 * its exported digest and the descendant inventory is checked again. Changes
 * fail the stream rather than completing a ZIP from inconsistent observations.
 * @param deps - mounted persistence, query, attachment, and live-session services.
 * @param rootContent - root log already read after its flush barrier.
 * @param sessionId - exported root identity.
 * @param includeDescendants - whether to include subagent logs.
 * @param bundle - validated resident or single-consumption context from the recorded source driver.
 * @param policy - optional uncompressed byte limits for this archive.
 * @param signal - request and consumer cancellation.
 * @param workspace - optional captured workspace selected by the caller.
 * @returns ordinary ZIP entries ending with `manifest.json`.
 */
export async function* portableSessionZipEntries(
  deps: SessionLogExportReady,
  rootContent: string,
  sessionId: SessionId,
  includeDescendants: boolean,
  bundle: PortableAgentBundleV1 | PortableAgentStreamBundleV1,
  policy: DshArchiveResourcePolicy = {},
  signal?: AbortSignal,
  workspace?: DshWorkspaceExport,
): AsyncGenerator<SessionLogZipEntry> {
  const receipts: DshArchiveEntryV1[] = []
  const logs = new Map<SessionId, string>()
  const budget = createDshArchiveResourceBudget(policy)
  const append = function* (entry: SessionLogZipEntry, kind: DshArchiveEntryV1['kind']) {
    const measured = measureDshArchiveEntry(entry, kind, budget)
    yield measured.entry
    receipts.push(measured.receipt())
  }
  for await (const entry of sessionLogZipEntries(deps, rootContent, sessionId, includeDescendants, signal)) {
    const kind = entryKind(entry.path)
    if (kind === 'session-log') {
      if (!('content' in entry)) throw new Error('session export: logical log is not serialized text')
      const header = JSON.parse(entry.content.slice(0, entry.content.indexOf('\n'))) as SessionHeader
      logs.set(header.id, createHash('sha256').update(entry.content).digest('hex'))
    }
    yield* append(entry, kind)
  }
  const checkAttachments = portableAttachmentChecker(receipts)
  yield* append({ path: DRIVER_PATH, content: JSON.stringify(bundle.context.source) }, 'driver-state')
  if (streamed(bundle)) {
    yield* append({ path: CONTEXT_PATH,
      chunks: portableContextJsonStream(bundle.context, (item) => { if (!('encoding' in item)) checkAttachments(item.content) }) }, 'portable-context')
  } else {
    for (const item of bundle.context.items) checkAttachments(item.content)
    yield* append({ path: CONTEXT_PATH, chunks: portableJsonStream(bundle.context) }, 'portable-context')
  }
  if (bundle.privateSnapshot !== undefined) {
    yield* append({ path: PRIVATE_PATH, chunks: streamedPrivate(bundle.privateSnapshot)
      ? privateSnapshotJsonStream(bundle.privateSnapshot)
      : portableJsonStream(bundle.privateSnapshot) }, 'private-snapshot')
  }
  const cwd = sourceCwd(rootContent)
  if (workspace !== undefined) {
    for (const entry of workspace.entries(signal)) yield* append(entry, 'workspace')
    await workspace.verify(signal)
  }
  const workspaceMetadata = workspace?.metadata ?? { sourceCwd: cwd, ...await fingerprintDshWorkspace(cwd, signal), snapshot: null }
  await verifyStableLogs(deps, sessionId, logs, includeDescendants, signal)
  const manifest = completeDshArchiveManifestV1({
    rootSessionId: sessionId,
    sessionLogPath: SESSION_LOG_FILENAME,
    driverStatePath: DRIVER_PATH,
    contextPath: CONTEXT_PATH,
    privateSnapshotPath: bundle.privateSnapshot === undefined ? null : PRIVATE_PATH,
    workspace: workspaceMetadata,
  }, receipts)
  const manifestContent = JSON.stringify(manifest)
  const manifestBytes = Buffer.byteLength(manifestContent)
  budget.accept('manifest.json', manifestBytes, manifestBytes)
  yield { path: 'manifest.json', content: manifestContent }
}
