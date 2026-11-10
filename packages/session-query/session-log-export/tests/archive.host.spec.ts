/**
 * session.export host path: the GET download endpoint streams a ZIP whose
 * files are the sessions' logical logs serialized as canonical JSONL (root +
 * optional descendants) read through persistence read handles, and the
 * degenerate compositions fail loudly (missing services → 500, missing root →
 * 404, missing descendant → errored stream).
 */

import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { unzipSync, strFromU8 } from 'fflate'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PortableAgentBundleV1, PortableAgentStreamBundleV1 } from '@deepseek-ai/dsh-agent'
import { projectStandardSession, standardTransferSource, standardTransferTarget } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import * as SessionLogExport from '../src/index.ts'

const sid = (id: string): SessionId => id as SessionId
const exportLogName = SessionLogExport.SESSION_LOG_FILENAME
const subagentLogName = (id: string): string => `subagents/${id}/${exportLogName}`
const generationLogName = (version: number): string => version === 0
  ? 'session.jsonl'
  : `session.v${version}.jsonl`

function header(id: string, parentSession?: SessionId): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1000,
    isSeeded: false,
    cwd: '/proj',
    ...parentSession === undefined ? {} : { parentSession },
    delegationDepth: parentSession === undefined ? 0 : 1,
  }
}

/** One stored logical session log served by the fake persistence backend. */
interface StoredLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

const turnStart: SessionEvent = { type: 'turn/start', seq: SessionSeq(0), time: 2000, data: { turn: 1 } }
const standardDriverSelected: SessionEvent = { type: 'agent/driver-selected', seq: SessionSeq(0), time: 1000,
  data: { version: 1, driverId: 'standard' } }

function portableBundle(): PortableAgentBundleV1 {
  return {
    context: {
      version: 1,
      source: { version: 1, sessionId: 'session-root', driver: { id: 'standard', version: '1' },
        model: { provider: 'fixture', id: 'fixture-model' } },
      items: [{ id: 'message-1', role: 'user', content: [{ kind: 'text', text: 'private prompt' }],
        provenance: { kind: 'user' } }],
      effectiveItemIds: ['message-1'], compactions: [],
    },
    privateSnapshot: { version: 1, driverId: 'standard', driverRevision: 'test', schemaVersion: 1,
      context: { marker: 'private checkpoint' } },
  }
}

function streamedBundle(bundle: PortableAgentBundleV1 = portableBundle()): PortableAgentStreamBundleV1 {
  return {
    context: { version: bundle.context.version, source: bundle.context.source,
      items: (async function* () { yield* bundle.context.items })(),
      effectiveItemIds: (async function* () { yield* bundle.context.effectiveItemIds })(),
      compactions: (async function* () { yield* bundle.context.compactions })() },
    ...bundle.privateSnapshot === undefined ? {} : { privateSnapshot: bundle.privateSnapshot },
  }
}

function log(id: string, parentSession?: SessionId, events: readonly SessionEvent[] = [turnStart]): StoredLog {
  return { header: header(id, parentSession), events }
}

/** The expected zip text for one stored log: the canonical JSONL serialization. */
function logText(stored: StoredLog): string {
  return SessionLogExport.serializeSessionLog(stored.header, stored.events)
}

function node(id: string, ...descendants: SessionLineageNode[]): SessionLineageNode {
  return { session: { header: header(id, sid('session-root')), live: false, persisted: true }, descendants }
}

/** One durable image object served by the fake attachment store. */
function storedImage(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png') {
  return {
    ref: { attachmentId: sid(id), mediaType, bytes: 4, width: 2, height: 2 } as unknown as ImageAttachmentRef,
    data: new Uint8Array([1, 2, 3, 4]),
  }
}

/** A user/message event carrying one image reference. */
function imageEvent(id: string, mediaType: ImageAttachmentRef['mediaType'] = 'image/png'): SessionEvent {
  return {
    type: 'user/message', seq: SessionSeq(1), time: 1000,
    data: { content: [{ type: 'image', attachment: { attachmentId: id, mediaType, bytes: 4, width: 2, height: 2 } }] },
  } as unknown as SessionEvent
}

/** A read handle over one stored log; only what readSessionLogText touches. */
function readHandle(stored: StoredLog): SessionHandle {
  return {
    id: stored.header.id,
    header: stored.header,
    access: 'read',
    inheritedEventCount: 0,
    read: async () => stored.events,
    close: async () => {},
  } as unknown as SessionHandle
}

/** A user/message event carrying one generic-file reference. */
function fileEvent(id: string, name = 'notes.txt', bytes = 5, seq = SessionSeq(1)): SessionEvent {
  return {
    type: 'user/message', seq, time: 1000,
    data: { content: [{ type: 'file', attachment: { attachmentId: id, name, bytes } }] },
  } as unknown as SessionEvent
}

function auditArtifactEvents(sha256: string, bytes: number, threadId = 'thread-1'): SessionEvent[] {
  return [
    { type: 'codex/artifact-v1', seq: SessionSeq(0), time: 1000, data: {
      version: 1, threadId, sha256, bytes, mediaType: 'application/json',
      name: `dsh-audit-${sha256}.blob`,
    } },
    { type: 'codex/audit-v1', seq: SessionSeq(1), time: 1001, data: {
      version: 1, sequence: 1, eventId: 'model-request-1', time: 1001, threadId, turn: 1,
      kind: 'model/request', attemptId: 'attempt-1', purpose: 'inference', stage: 'model-visible',
      apiFormat: 'responses', request: { kind: 'artifact', sha256, bytes, mediaType: 'application/json' },
    } },
  ] as SessionEvent[]
}

async function buildApi(
  logs: Record<string, StoredLog>,
  descendants: SessionLineageNode[] = [],
  services: {
    query?: boolean
    persistence?: boolean | 'throw'
    attachments?: boolean | ((ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<ReturnType<typeof storedImage>>)
    readFileStream?: (ref: FileAttachmentRef, signal?: AbortSignal) => AsyncIterable<Uint8Array>
    sessions?: {
      get(id: SessionId): { readonly id: SessionId } | undefined
      flush(session: { readonly id: SessionId }): Promise<boolean>
    }
    open?: (id: SessionId, access: SessionAccess, options?: { signal?: AbortSignal }) => Promise<SessionHandle>
    traceSession?: (id: SessionId, signal?: AbortSignal) => Promise<{
      target: { header: SessionHeader; live: boolean; persisted: boolean }
      ancestors: readonly SessionLineageNode[]
      complete: boolean
      root: { header: SessionHeader; live: boolean; persisted: boolean }
      descendants: readonly SessionLineageNode[]
    }>
    compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
    maxPortableEntryBytes?: number
    maxPortableTotalUncompressedBytes?: number
    portableBundle?: PortableAgentBundleV1
    portableStream?: () => Promise<PortableAgentStreamBundleV1>
  } = {},
) {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  const query = services.query ?? true
  const persistence = services.persistence ?? true
  if (query) {
    ctx.provide('sessionQuery', {
      traceSession: services.traceSession ?? (async () => ({
        target: { header: header('session-root'), live: false, persisted: true },
        ancestors: [],
        complete: true,
        root: { header: header('session-root'), live: false, persisted: true },
        descendants,
      })),
    } as never)
  }
  if (persistence) {
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => {
        // A custom `open` owns the scenario: absence must reach it, not stop here.
        if (services.open !== undefined || persistence === 'throw') return { header: header(String(id)) }
        const stored = logs[id]
        return stored === undefined ? undefined : { header: stored.header }
      },
      open: services.open ?? (async (id: SessionId) => {
        if (persistence === 'throw') throw new Error('/host/private/session.jsonl')
        const stored = logs[id]
        if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
        return readHandle(stored)
      }),
    } as never)
  }
  if (services.attachments !== false) {
    const readImage = typeof services.attachments === 'function'
      ? services.attachments
      : async (ref: ImageAttachmentRef) => storedImage(String(ref.attachmentId), ref.mediaType)
    ctx.provide('attachments', {
      imageLimits: {} as never,
      validateImage: async () => {},
      saveImage: async () => { throw new Error('export never saves images') },
      readImage,
      readFileStream: services.readFileStream ?? (async function* () {
        throw new Error('fixture has no files')
      }),
    } as never)
  }
  if (services.sessions !== undefined) ctx.provide('sessions', services.sessions as never)
  if (services.portableBundle !== undefined || services.portableStream !== undefined) ctx.provide('agents', {
    getTransferPorts: () => ({ source: {
      driverId: 'standard', exportArchivedContext: vi.fn(), exportPortableContext: async () => services.portableBundle,
      ...services.portableStream === undefined ? {} : { exportPortableContextStream: services.portableStream },
    } }),
  } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin(SessionLogExport, {
    ...services.compressionLevel === undefined
      ? {}
      : { compressionLevel: services.compressionLevel },
    ...services.maxPortableEntryBytes === undefined
      ? {}
      : { maxPortableEntryBytes: services.maxPortableEntryBytes },
    ...services.maxPortableTotalUncompressedBytes === undefined
      ? {}
      : { maxPortableTotalUncompressedBytes: services.maxPortableTotalUncompressedBytes },
  })
  await fiber.await()
  const handler = connection.createSharedFetchHandler('/api')
  return {
    fetch: handler,
    dispose: () => fiber.dispose(),
    downloads: {
      sessionLog: (
        request: { sessionId: SessionId; includeDescendants: boolean; format?: 'portable' | 'log' },
        signal: AbortSignal,
      ): Promise<Response> => {
        const url = new URL(`http://host${SessionLogExport.SESSION_LOG_EXPORT_PATH}`)
        url.searchParams.set('sessionId', request.sessionId)
        url.searchParams.set('includeDescendants', String(request.includeDescendants))
        if (request.format !== undefined) url.searchParams.set('format', request.format)
        return handler.fetch(new Request(url, { signal }))
      },
    },
  }
}

function toFetchHandler(api: Awaited<ReturnType<typeof buildApi>>): { fetch(request: Request): Promise<Response> } {
  return api.fetch
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

/** Minimal ready services for the direct streamSessionLogZip chunking tests. */
function directReady(): SessionLogExport.SessionLogExportReady {
  return {
    sessionQuery: { traceSession: async () => { throw new Error('unused') } } as never,
    sessionPersistence: { open: async () => { throw new Error('unused') } } as never,
    attachments: { readImage: async () => { throw new Error('no media') } } as never,
    sessions: undefined,
  }
}

/** Consume one directly built zip stream into its unpacked files. */
async function directZipFiles(rootContent: string): Promise<Record<string, Uint8Array>> {
  const stream = SessionLogExport.streamSessionLogZip(
    directReady(), rootContent, sid('session-root'), false, 6, new AbortController().signal,
  )
  return unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()))
}

describe('session export compression config', () => {
  it('defaults to level 6 and rejects values outside the integer 0-9 range', () => {
    expect(SessionLogExport.Config({})).toEqual({
      compressionLevel: 6,
    })
    expect(SessionLogExport.Config({ compressionLevel: 0 }))
      .toEqual({ compressionLevel: 0 })
    expect(SessionLogExport.Config({ compressionLevel: 9 }))
      .toEqual({ compressionLevel: 9 })
    for (const value of [-1, 10, 1.5]) {
      expect(() => SessionLogExport.Config({ compressionLevel: value } as never)).toThrow()
    }
  })
})

describe('serializeSessionLog', () => {
  it('uses the canonical current-generation export filename', () => {
    expect(SessionLogExport.SESSION_LOG_FILENAME).toBe(generationLogName(SESSION_FORMAT_VERSION))
  })

  it('writes the physical header line, one line per event, and a trailing newline', () => {
    const stored = log('session-root')
    expect(logText(stored)).toBe(
      `${JSON.stringify({
        type: 'session', version: SESSION_FORMAT_VERSION, id: sid('session-root'), createdAt: 1000,
        cwd: '/proj', isSeeded: false, delegationDepth: 0,
      })}\n${JSON.stringify(turnStart)}\n`,
    )
  })

  it('serializes v2 lineage through the tagged marker and defaults delegationDepth to 0', () => {
    const seeded: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sid('seeded'),
      createdAt: 1000,
      isSeeded: true,
      parentSession: sid('parent'),
      origin: 'subagent',
      agentPreset: 'minimal',
    }
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'session/end-seed', seq: SessionSeq(2), time: 2, data: { inherited: true } },
    ]
    expect(SessionLogExport.serializeSessionLog(seeded, events)).toBe(`${JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: sid('seeded'),
      createdAt: 1000,
      parentSession: sid('parent'),
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 0,
      agentPreset: 'minimal',
    })}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  })

  it('round-trips import ancestry from a ZIP log through the current Session-format reader', async () => {
    const importLineage = {
      sourceSessionId: sid('source-session'),
      sourceDriverId: 'codex',
      importId: 'transfer-1',
    }
    const stored: StoredLog = {
      header: { ...header('session-root'), importLineage },
      events: [],
    }
    const api = await buildApi({ 'session-root': stored })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    const text = strFromU8(files[exportLogName] as Uint8Array)
    const [headerLine, ...eventLines] = text.trimEnd().split('\n')
    const physicalHeader = JSON.parse(headerLine as string) as unknown
    expect(physicalHeader).toEqual({
      type: 'session', version: SESSION_FORMAT_VERSION,
      id: stored.header.id, createdAt: stored.header.createdAt,
      cwd: stored.header.cwd, importLineage, isSeeded: false, delegationDepth: 0,
    })
    const decoded = sessionFormatCatalog.decodeArtifact(
      physicalHeader,
      eventLines.map(line => JSON.parse(line) as unknown),
    )
    expect(sessionFormatCatalog.migrate(decoded).header.importLineage).toEqual(importLineage)
  })
})

describe('readSessionLogText', () => {
  it('reads without a signal and maps only open not-found to undefined', async () => {
    const stored = log('session-root')
    const persistence = {
      open: async (id: SessionId) => {
        if (id !== stored.header.id) throw new SessionPersistenceNotFoundError(id)
        return readHandle(stored)
      },
    } as never
    await expect(SessionLogExport.readSessionLogText(persistence, sid('session-root')))
      .resolves.toBe(logText(stored))
    await expect(SessionLogExport.readSessionLogText(persistence, sid('absent')))
      .resolves.toBeUndefined()
  })

  it('propagates a non-not-found open failure', async () => {
    const persistence = {
      open: async () => { throw new Error('EACCES: permission denied') },
    } as never
    await expect(SessionLogExport.readSessionLogText(persistence, sid('session-root')))
      .rejects.toThrow('EACCES: permission denied')
  })
})

describe('session.export download endpoint', () => {
  it('removes the import preview route when its plugin is disposed', async () => {
    const api = await buildApi({})
    const request = (): Request => new Request('http://host/api/session.import.preview?driverId=standard&provider=mock&model=model', {
      method: 'POST', headers: { 'content-type': 'application/zip' }, body: new Uint8Array([1]),
    })
    expect((await toFetchHandler(api).fetch(request())).status).toBe(503)
    await api.dispose()
    expect((await toFetchHandler(api).fetch(request())).status).toBe(404)
  })

  it.each(['GET', 'HEAD'])('defaults %s to portable without falling back to transcript-only', async (method) => {
    const api = await buildApi({ 'session-root': log('session-root', undefined, [standardDriverSelected]) }, [],
      { portableBundle: portableBundle() })
    const response = await toFetchHandler(api).fetch(new Request('http://host/api/session.export?sessionId=session-root', { method }))
    expect(response.status).toBe(200)
    if (method === 'GET') {
      const files = unzipSync(await responseBytes(response))
      expect(Object.keys(files)).toContain('manifest.json')
      expect(Object.keys(files)).toContain('agent/context.json')
    } else expect(await response.text()).toBe('')
    for (const events of [[], [standardDriverSelected]]) {
      const unavailable = await buildApi({ 'session-root': log('session-root', undefined, events) })
      const rejected = await toFetchHandler(unavailable).fetch(
        new Request('http://host/api/session.export?sessionId=session-root', { method }),
      )
      expect(rejected.status).toBe(409)
    }
  })

  it('rejects an unknown format instead of selecting a default', async () => {
    const api = await buildApi({ 'session-root': log('session-root') })
    const response = await toFetchHandler(api).fetch(new Request('http://host/api/session.export?sessionId=session-root&format=unknown'))
    expect(response.status).toBe(400)
  })

  it('records a versioned workspace fingerprint without including workspace bytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-export-fingerprint-'))
    try {
      await writeFile(join(workspace, 'project.txt'), 'workspace-only content')
      const stored = log('session-root', undefined, [standardDriverSelected])
      const api = await buildApi({ 'session-root': { ...stored, header: { ...stored.header, cwd: workspace } } }, [],
        { portableBundle: portableBundle() })
      const response = await api.downloads.sessionLog({ sessionId: sid('session-root'), includeDescendants: false, format: 'portable' },
        new AbortController().signal)
      const files = unzipSync(await responseBytes(response))
      const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as SessionLogExport.DshSessionArchiveManifestV1
      expect(manifest.workspace).toEqual({
        sourceCwd: workspace, ...await SessionLogExport.fingerprintDshWorkspace(workspace), snapshot: null,
      })
      expect(manifest.workspace.fingerprintAlgorithm).toBe('dsh-workspace-content-v1')
      expect(manifest.entries.some(entry => entry.kind === 'workspace')).toBe(false)
      expect(Object.values(files).map(data => strFromU8(data)).join('')).not.toContain('workspace-only content')
      expect((await SessionLogExport.previewDshWorkspaceImport(manifest.workspace, workspace)).fingerprintComparison).toBe('matching-content')
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  it('wraps a source-validated private JSON stream and withholds the manifest on digest failure', async () => {
    const resident = portableBundle()
    const snapshot = resident.privateSnapshot
    if (snapshot === undefined) throw new Error('missing private fixture')
    const contextBytes = Buffer.from(JSON.stringify(snapshot.context))
    const digest = createHash('sha256').update(contextBytes).digest('hex')
    const streamedPrivate = (sha256 = digest, bytes = contextBytes.byteLength): PortableAgentStreamBundleV1 => ({
      ...streamedBundle(resident),
      privateSnapshot: { version: snapshot.version, driverId: snapshot.driverId,
        driverRevision: snapshot.driverRevision, schemaVersion: snapshot.schemaVersion,
        contextJson: (async function* () {
          yield contextBytes.subarray(0, 5)
          yield contextBytes.subarray(5)
        })(), contextBytes: bytes, contextSha256: sha256 },
    })
    const root = logText(log('session-root', undefined, [standardDriverSelected]))
    const ready = { ...directReady(), sessionPersistence: { open: async () =>
      readHandle(log('session-root', undefined, [standardDriverSelected])) } as never }
    SessionLogExport.validatePortableArchiveBundle(streamedPrivate(), sid('session-root'), 'standard')
    expect(() => { SessionLogExport.validatePortableArchiveBundle(
      streamedPrivate(digest, 0), sid('session-root'), 'standard',
    ) }).toThrow('incompatible portable context')
    const files = new Map<string, Uint8Array>()
    for await (const entry of SessionLogExport.portableSessionZipEntries(
      ready, root, sid('session-root'), false, streamedPrivate(),
    )) {
      if ('content' in entry) files.set(entry.path, Buffer.from(entry.content))
      else if ('data' in entry) files.set(entry.path, entry.data)
      else {
        const parts: Uint8Array[] = []
        for await (const part of entry.chunks) parts.push(part)
        files.set(entry.path, Buffer.concat(parts))
      }
    }
    expect(files.get('agent/private-snapshot.json')).toEqual(Buffer.from(JSON.stringify(snapshot)))
    expect(files.has('manifest.json')).toBe(true)
    const seen: string[] = []
    await expect((async () => {
      for await (const entry of SessionLogExport.portableSessionZipEntries(
        ready, root, sid('session-root'), false, streamedPrivate('0'.repeat(64)),
      )) {
        seen.push(entry.path)
        if ('chunks' in entry) for await (const part of entry.chunks) void part
      }
    })()).rejects.toThrow('private checkpoint hash or size differs')
    expect(seen).not.toContain('manifest.json')
    await expect((async () => {
      for await (const entry of SessionLogExport.portableSessionZipEntries(
        ready, root, sid('session-root'), false, streamedPrivate(digest, contextBytes.byteLength + 1),
      )) {
        if ('chunks' in entry) for await (const part of entry.chunks) void part
      }
    })()).rejects.toThrow('private checkpoint hash or size differs')
    await expect((async () => {
      for await (const entry of SessionLogExport.portableSessionZipEntries(
        ready, root, sid('session-root'), false, streamedPrivate(digest, contextBytes.byteLength - 1),
      )) {
        if ('chunks' in entry) for await (const part of entry.chunks) void part
      }
    })()).rejects.toThrow('private checkpoint exceeded its declared size')
  })

  it.each(['image-1', `sha256:${createHash('sha256').update(Uint8Array.of(1, 2, 3, 4)).digest('hex')}`])
  ('exports standard-driver image %s without changing its canonical identity', async (imageId) => {
    const session = Session.create(SessionId('session-root'))
    session.append('agent/driver-selected', { version: 1, driverId: 'standard' })
    session.append('request/header', { reason: 'initial',
      header: { config: { provider: 'fixture', model: 'fixture-model' }, system: 'System instruction' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image',
      attachment: { attachmentId: imageId as never, mediaType: 'image/png', bytes: 4, width: 2, height: 2 } }] }),
    { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const port = standardTransferSource(() => session)
    const api = await buildApi({ 'session-root': { header: header('session-root'), events: session.snapshotEvents() } }, [], {
      portableStream: async () => {
        const bundle = await port.exportPortableContextStream?.(sid('session-root'))
        if (bundle === undefined) throw new Error('standard stream port is unavailable')
        return bundle
      },
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(200)
    const zip = await responseBytes(response)
    const files = unzipSync(zip)
    expect(files['agent/context.json']).toEqual(new Uint8Array(Buffer.from(JSON.stringify(projectStandardSession(session)))))
    const imagePath = `media/${imageId.replace(/^sha256:/u, '')}.png`
    expect(files[imagePath]).toEqual(Uint8Array.of(1, 2, 3, 4))
    expect(files['manifest.json']).toBeDefined()
    expect(strFromU8(files[exportLogName]!)).toContain(imageId)
    const staging = await mkdtemp(join(tmpdir(), 'dsh-image-export-'))
    try {
      const path = join(staging, 'session.zip')
      await writeFile(path, zip, { mode: 0o600 })
      const manifest = await SessionLogExport.validateDshSessionZip(path)
      const preview = await SessionLogExport.readDshSessionArchiveBundle(path, manifest, sessionFormatCatalog)
      expect(preview.bundle.context).toEqual(projectStandardSession(session))
      const resolveLive = vi.fn(() => { throw new Error('archive verification must not read the live Session') })
      await SessionLogExport.verifyDshSessionArchiveProjection(path, manifest, preview, standardTransferSource(resolveLive))
      const targetModel = { provider: 'fixture', id: 'fixture-model' }
      const target = standardTransferTarget(() => [targetModel], async () => ({ status: 'missing', reference: 'IMPORT_KEY' }))
      const importOperation = vi.spyOn(target, 'importPortableContext')
      const combined = await SessionLogExport.previewDshSessionArchive(path, sessionFormatCatalog,
        standardTransferSource(resolveLive), target, targetModel, {}, undefined, staging)
      expect(combined.bundle).toEqual(preview.bundle)
      expect(combined.authentication).toEqual({ status: 'missing', reference: 'IMPORT_KEY' })
      expect(combined.workspace.targetExists).toBe(true)
      expect(combined.workspace.choices.map(choice => choice.action)).toEqual(['keep-workspace'])
      expect(importOperation).not.toHaveBeenCalled()
      expect(resolveLive).not.toHaveBeenCalled()
      await expect(SessionLogExport.verifyDshSessionArchiveProjection(path, manifest,
        { ...preview, bundle: { context: { ...preview.bundle.context, effectiveItemIds: [] } } }, port))
        .rejects.toThrow('differs from source projection')
      expect(manifest.entries).toContainEqual({ path: imagePath, kind: 'attachment', bytes: 4,
        sha256: createHash('sha256').update(Uint8Array.of(1, 2, 3, 4)).digest('hex') })
    } finally { await rm(staging, { recursive: true, force: true }) }
  })

  it('exports recorded import ancestry through the portable download route', async () => {
    const importedHeader = { ...header('session-root'), importLineage: {
      sourceSessionId: sid('prior-session'), sourceDriverId: 'standard', importId: 'prior-import',
    } }
    const source = Session.create(sid('session-root'), [], importedHeader)
    source.append('agent/driver-selected', { version: 1, driverId: 'standard' })
    source.append('request/header', { reason: 'initial',
      header: { config: { provider: 'fixture', model: 'fixture-model' } } })
    const port = standardTransferSource(() => source)
    const api = await buildApi({ 'session-root': { header: importedHeader, events: source.snapshotEvents() } }, [], {
      portableStream: async () => {
        const bundle = await port.exportPortableContextStream?.(source.id)
        if (bundle === undefined) throw new Error('standard stream is required')
        return bundle
      },
    })
    const response = await api.downloads.sessionLog({ sessionId: source.id,
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(JSON.parse(strFromU8(files['agent/driver.json']!))).toMatchObject({ lineage: importedHeader.importLineage })
    expect(JSON.parse(strFromU8(files['agent/context.json']!))).toMatchObject({ source: { lineage: importedHeader.importLineage } })
    expect(JSON.parse(strFromU8(files[exportLogName]!).split('\n')[0]!)).toMatchObject({ importLineage: importedHeader.importLineage })
  })

  it('writes a streamed opaque value into the ordinary portable ZIP context and manifest', async () => {
    const bytes = Buffer.from(JSON.stringify({ prompt: 'pełna treść'.repeat(10000) }))
    const bundle = streamedBundle()
    const source: PortableAgentStreamBundleV1 = { ...bundle, context: { ...bundle.context,
      items: (async function* () {
        yield { encoding: 'opaque-json' as const, id: 'message-1', role: 'developer' as const,
          namespace: 'fixture.prompt.v1', provenance: { kind: 'compaction' as const },
          json: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
            chunks: (async function* () { for (let i = 0; i < bytes.length; i += 1024) yield bytes.subarray(i, i + 1024) })() } }
      })(),
    } }
    const api = await buildApi({ 'session-root': log('session-root', undefined, [standardDriverSelected]) }, [], {
      portableStream: async () => source,
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(200)
    const zip = await responseBytes(response)
    const files = unzipSync(zip)
    const contextBytes = files['agent/context.json']!
    expect(JSON.parse(strFromU8(contextBytes))).toMatchObject({ items: [{ id: 'message-1',
      content: [{ kind: 'opaque', namespace: 'fixture.prompt.v1', value: { prompt: 'pełna treść'.repeat(10000) } }] }] })
    const staging = await mkdtemp(join(tmpdir(), 'dsh-export-validate-'))
    try {
      const path = join(staging, 'session.zip')
      await writeFile(path, zip, { mode: 0o600 })
      const verified = await SessionLogExport.validateDshSessionZip(path)
      expect(verified).toEqual(JSON.parse(strFromU8(files['manifest.json']!)))
      const preview = await SessionLogExport.readDshSessionArchiveBundle(path, verified, sessionFormatCatalog)
      expect(preview.root.artifact.header.id).toBe('session-root')
      expect(preview.root.artifact.events).toEqual([standardDriverSelected])
    } finally { await rm(staging, { recursive: true, force: true }) }
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as { entries: unknown[] }
    expect(manifest.entries).toContainEqual({ path: 'agent/context.json', kind: 'portable-context', bytes: contextBytes.length,
      sha256: createHash('sha256').update(contextBytes).digest('hex') })
  })

  it('selects the source stream after a durable read and consumes it after the log consistency check', async () => {
    const order: string[] = []
    const stored = log('session-root', undefined, [standardDriverSelected])
    const bundle = streamedBundle()
    const stream: PortableAgentStreamBundleV1 = { ...bundle, context: { ...bundle.context,
      items: (async function* () {
        order.push('consume')
        yield* portableBundle().context.items
      })(),
    } }
    const api = await buildApi({}, [], {
      open: async () => {
        order.push('read')
        return readHandle(stored)
      },
      portableStream: async () => {
        order.push('acquire')
        return stream
      },
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(200)
    expect(order).toEqual(['read', 'acquire', 'read'])
    const files = unzipSync(await responseBytes(response))
    expect(order).toEqual(['read', 'acquire', 'read', 'consume', 'read'])
    expect(strFromU8(files['agent/context.json'] as Uint8Array)).toBe(JSON.stringify(portableBundle().context))
    expect(files['manifest.json']).toBeDefined()
  })

  it('does not consume a source stream if the durable log changes before ZIP emission', async () => {
    let reads = 0
    let consumed = false
    const before = log('session-root', undefined, [standardDriverSelected])
    const after = log('session-root', undefined, [standardDriverSelected,
      { ...turnStart, seq: SessionSeq(1) }])
    const bundle = streamedBundle()
    const api = await buildApi({}, [], {
      open: async () => readHandle(reads++ === 0 ? before : after),
      portableStream: async () => ({ ...bundle, context: { ...bundle.context,
        items: (async function* () { consumed = true; yield* portableBundle().context.items })(),
      } }),
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(409)
    expect(reads).toBe(2)
    expect(consumed).toBe(false)
  })

  it('fails the endpoint ZIP when a source item stream fails', async () => {
    const bundle = streamedBundle()
    const api = await buildApi({ 'session-root': log('session-root', undefined, [standardDriverSelected]) }, [], {
      portableStream: async () => ({ ...bundle, context: { ...bundle.context,
        items: (async function* () { throw new Error('source stream failed') })(),
      } }),
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('source stream failed')
  })

  it.each(['root', 'child', 'missing-child', 'new-child', 'flush-failure'] as const)
  ('refuses a completed portable ZIP after %s changes during streaming', async (change) => {
    const stored: Record<string, StoredLog> = {
      'session-root': log('session-root', undefined, [standardDriverSelected]),
      'child-a': log('child-a', sid('session-root')),
    }
    const descendants = [node('child-a')]
    let streaming = false
    const bundle = portableBundle()
    const api = await buildApi(stored, descendants, {
      sessions: { get: id => ({ id }), flush: async () => !(streaming && change === 'flush-failure') },
      portableStream: async () => ({ ...streamedBundle(bundle), context: { ...streamedBundle(bundle).context,
        items: (async function* () {
          streaming = true
          if (change === 'root') stored['session-root'] = log('session-root', undefined,
            [standardDriverSelected, { ...turnStart, seq: SessionSeq(1) }])
          if (change === 'child') stored['child-a'] = log('child-a', sid('session-root'), [])
          if (change === 'missing-child') delete stored['child-a']
          if (change === 'new-child') descendants.push(node('child-new'))
          yield* bundle.context.items
        })() } }),
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'), includeDescendants: true, format: 'portable' },
      new AbortController().signal)
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow(change === 'new-child' ? 'descendants changed'
      : change === 'flush-failure' ? 'no durability listener' : 'log changed during portable streaming')
  })

  it('measures a single-use context stream and refuses a final manifest for invalid source data', async () => {
    const root = logText(log('session-root', undefined, [standardDriverSelected]))
    const ready = { ...directReady(), sessionPersistence: { open: async () =>
      readHandle(log('session-root', undefined, [standardDriverSelected])) } as never }
    const bundle = streamedBundle()
    SessionLogExport.validatePortableArchiveBundle(bundle, sid('session-root'), 'standard')
    const files = new Map<string, Uint8Array>()
    for await (const entry of SessionLogExport.portableSessionZipEntries(
      ready, root, sid('session-root'), false, bundle,
    )) {
      if ('content' in entry) files.set(entry.path, Buffer.from(entry.content))
      else if ('data' in entry) files.set(entry.path, entry.data)
      else {
        const parts: Uint8Array[] = []
        for await (const part of entry.chunks) parts.push(part)
        files.set(entry.path, Buffer.concat(parts))
      }
    }
    expect(files.get('agent/context.json')).toEqual(Buffer.from(JSON.stringify(portableBundle().context)))
    const manifestBytes = files.get('manifest.json')
    const contextBytes = files.get('agent/context.json')
    if (manifestBytes === undefined || contextBytes === undefined) throw new Error('streamed archive is incomplete')
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as SessionLogExport.DshSessionArchiveManifestV1
    expect(manifest.entries.find(entry => entry.path === 'agent/context.json')?.sha256)
      .toBe(createHash('sha256').update(contextBytes).digest('hex'))

    const missing = portableBundle()
    const first = missing.context.items[0]
    if (first === undefined) throw new Error('missing portable fixture item')
    const invalid = streamedBundle({ context: { ...missing.context, items: [{ ...first,
      content: [{ kind: 'attachment', attachmentId: 'missing-image', mediaType: 'image/png' }],
    }] } })
    const seen: string[] = []
    await expect((async () => {
      for await (const entry of SessionLogExport.portableSessionZipEntries(
        ready, root, sid('session-root'), false, invalid,
      )) {
        seen.push(entry.path)
        if ('chunks' in entry) for await (const part of entry.chunks) void part
      }
    })()).rejects.toThrow('portable context attachment missing-image is missing from ZIP')
    expect(seen).not.toContain('manifest.json')

    const duplicate = streamedBundle({ context: { ...missing.context, items: [first, first] } })
    seen.length = 0
    await expect((async () => {
      for await (const entry of SessionLogExport.portableSessionZipEntries(
        ready, root, sid('session-root'), false, duplicate,
      )) {
        seen.push(entry.path)
        if ('chunks' in entry) for await (const part of entry.chunks) void part
      }
    })()).rejects.toThrow('portable context stream has an invalid or duplicate item')
    expect(seen).not.toContain('manifest.json')
  })

  it('exports a portable context, optional private state, and byte-exact final manifest', async () => {
    const stored = log('session-root', undefined, [standardDriverSelected])
    const bundle = portableBundle()
    const api = await buildApi({ 'session-root': stored }, [], { portableBundle: bundle })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files)).toEqual([
      exportLogName, 'agent/driver.json', 'agent/context.json', 'agent/private-snapshot.json', 'manifest.json',
    ])
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as SessionLogExport.DshSessionArchiveManifestV1
    expect(SessionLogExport.isDshSessionArchiveManifestV1(manifest)).toBe(true)
    expect(manifest.rootSessionId).toBe('session-root')
    expect(manifest.workspace).toEqual({ sourceCwd: '/proj', fingerprint: null, fingerprintUnavailable: 'missing', snapshot: null })
    expect(manifest.entries).toHaveLength(4)
    for (const entry of manifest.entries) {
      const bytes = files[entry.path]
      expect(bytes, entry.path).toBeDefined()
      expect(bytes?.byteLength).toBe(entry.bytes)
      expect(createHash('sha256').update(bytes as Uint8Array).digest('hex')).toBe(entry.sha256)
    }
    expect(strFromU8(files['agent/context.json'] as Uint8Array)).toBe(JSON.stringify(bundle.context))
    expect(strFromU8(files['agent/private-snapshot.json'] as Uint8Array)).toBe(JSON.stringify(bundle.privateSnapshot))
  })

  it('stops a portable ZIP stream when an operator byte policy is exceeded', async () => {
    const stored = log('session-root', undefined, [standardDriverSelected])
    const api = await buildApi({ 'session-root': stored }, [], {
      portableBundle: portableBundle(), maxPortableEntryBytes: 16,
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('maxEntryBytes')
  })

  it('measures streamed file bytes and omits undeclared private state', async () => {
    const digest = 'a'.repeat(64)
    const stored = log('session-root', undefined, [standardDriverSelected,
      fileEvent(`sha256:${digest}`, 'notes.txt', 5, SessionSeq(1))])
    const bundle = portableBundle()
    const item = bundle.context.items[0]
    if (item === undefined) throw new Error('missing portable fixture item')
    const api = await buildApi({ 'session-root': stored }, [], {
      portableBundle: { context: { ...bundle.context, items: [{ ...item,
        content: [{ kind: 'attachment', attachmentId: `sha256:${digest}`,
          mediaType: 'application/octet-stream', name: 'notes.txt' }],
      }] } },
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2)
        yield Uint8Array.of(3, 4, 5)
      })(),
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    const files = unzipSync(await responseBytes(response))
    const path = `files/aa/${digest}/notes.txt`
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as SessionLogExport.DshSessionArchiveManifestV1
    expect(files[path]).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    expect(manifest.privateSnapshotPath).toBeNull()
    expect(files['agent/private-snapshot.json']).toBeUndefined()
    expect(manifest.entries.find(entry => entry.path === path)).toEqual({
      path, kind: 'attachment', bytes: 5,
      sha256: createHash('sha256').update(files[path] as Uint8Array).digest('hex'),
    })
  })

  it('requires the exact ZIP file name when a portable reference declares one', async () => {
    const digest = 'a'.repeat(64)
    const id = `sha256:${digest}`
    const stored = log('session-root', undefined, [standardDriverSelected, fileEvent(id, 'notes.txt')])
    const original = portableBundle()
    const item = original.context.items[0]
    if (item === undefined) throw new Error('missing portable fixture item')
    const context = (name?: string): PortableAgentBundleV1 => ({ context: { ...original.context,
      items: [{ ...item, content: [{ kind: 'attachment', attachmentId: id,
        mediaType: 'application/octet-stream', ...name === undefined ? {} : { name } }] }],
    } })
    const readFileStream = () => (async function* () { yield Uint8Array.of(1, 2, 3, 4, 5) })()
    for (const streamed of [false, true]) {
      const api = await buildApi({ 'session-root': stored }, [], {
        readFileStream,
        ...streamed ? { portableStream: async () => streamedBundle(context('wrong.txt')) }
          : { portableBundle: context('wrong.txt') },
      })
      const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
        includeDescendants: false, format: 'portable' }, new AbortController().signal)
      await expect(response.arrayBuffer()).rejects.toThrow(`portable context attachment ${id} is missing from ZIP`)
    }
    const unnamed = await buildApi({ 'session-root': stored }, [], {
      portableStream: async () => streamedBundle(context()), readFileStream,
    })
    const response = await unnamed.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    const files = unzipSync(await responseBytes(response))
    expect(files['manifest.json']).toBeDefined()

    const normalized = await buildApi({ 'session-root': log('session-root', undefined, [standardDriverSelected,
      fileEvent(id, 'dir/notes.txt')]) }, [], {
      portableBundle: context('dir/notes.txt'), readFileStream,
    })
    const normalizedResponse = await normalized.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    const normalizedFiles = unzipSync(await responseBytes(normalizedResponse))
    expect(normalizedFiles[`files/aa/${digest}/dir_notes.txt`]).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
  })

  it('fails the portable ZIP if canonical context references absent attachment bytes', async () => {
    const bundle = portableBundle()
    const item = bundle.context.items[0]
    if (item === undefined) throw new Error('missing portable fixture item')
    const context: PortableAgentBundleV1['context'] = { ...bundle.context, items: [{ ...item,
      content: [{ kind: 'tool-result', callId: 'call-1', isError: false, content: [
        { kind: 'attachment', attachmentId: 'missing-image', mediaType: 'image/png' },
      ] }],
    }] }
    const api = await buildApi({ 'session-root': log('session-root', undefined, [standardDriverSelected]) }, [], {
      portableBundle: { context },
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    await expect(response.arrayBuffer()).rejects.toThrow('portable context attachment missing-image is missing from ZIP')
  })

  it('refuses portable export without a source port or with a mismatched source identity', async () => {
    const stored = log('session-root', undefined, [standardDriverSelected])
    const missing = await buildApi({ 'session-root': stored })
    const missingResponse = await missing.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(missingResponse.status).toBe(409)
    expect(await missingResponse.text()).toContain('portable session export is unavailable')

    const wrong = portableBundle()
    const invalid = await buildApi({ 'session-root': stored }, [], {
      portableBundle: { ...wrong, context: { ...wrong.context,
        source: { ...wrong.context.source, sessionId: 'other-session' } } },
    })
    const invalidResponse = await invalid.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(invalidResponse.status).toBe(409)
    expect(invalidResponse.body).toBeDefined()
  })

  it('refuses a portable archive when the durable source driver is absent', async () => {
    const api = await buildApi({ 'session-root': log('session-root') }, [], { portableBundle: portableBundle() })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('portable session export is unavailable')
  })

  it('refuses a portable archive when the Session changes while its source context is read', async () => {
    let reads = 0
    const before = log('session-root', undefined, [standardDriverSelected])
    const after = log('session-root', undefined, [standardDriverSelected,
      { ...turnStart, seq: SessionSeq(1) }])
    const api = await buildApi({}, [], {
      portableBundle: portableBundle(),
      open: async () => readHandle(reads++ === 0 ? before : after),
    })
    const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: false, format: 'portable' }, new AbortController().signal)
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('session changed during portable export')
    expect(reads).toBe(2)
  })

  it('streams a ZIP with the root log serialized as canonical JSONL', async () => {
    const stored = log('session-root')
    const api = await buildApi({ 'session-root': stored })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('dsh-session-session-root.zip')
    const bytes = await responseBytes(response)
    const files = unzipSync(bytes)
    const staging = await mkdtemp(join(tmpdir(), 'dsh-log-only-import-'))
    try {
      const path = join(staging, 'session.zip')
      await writeFile(path, bytes, { mode: 0o600 })
      await expect(SessionLogExport.validateDshSessionZip(path)).rejects.toBeInstanceOf(SessionLogExport.DshArchiveManifestRequiredError)
    } finally { await rm(staging, { recursive: true, force: true }) }
    expect(Object.keys(files)).toEqual([exportLogName])
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(logText(stored))
  })

  it('preflights root preparation through HEAD without streaming a body', async () => {
    const open = vi.fn(async () => readHandle(log('session-root')))
    const api = await buildApi({}, [], { open })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root', { method: 'HEAD' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('dsh-session-session-root.zip')
    expect(response.body).toBeNull()
    expect(open).toHaveBeenCalledOnce()
  })

  it('returns a bodyless preparation error from HEAD', async () => {
    const api = await buildApi({})
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root', { method: 'HEAD' }),
    )

    expect(response.status).toBe(404)
    expect(response.body).toBeNull()
  })

  it('uses the resolved compression level for ZIP entries', async () => {
    const filler = {
      type: 'user/message', seq: SessionSeq(1), time: 1000,
      data: { content: [{ type: 'text', text: 'compressible '.repeat(32 * 1024) }] },
    } as unknown as SessionEvent
    const stored = log('session-root', undefined, [turnStart, filler])
    const storedApi = await buildApi({ 'session-root': stored }, [], { compressionLevel: 0 })
    const compressedApi = await buildApi({ 'session-root': stored }, [], { compressionLevel: 9 })
    const uncompressed = await storedApi.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false, format: 'log' },
      new AbortController().signal,
    )
    const compressed = await compressedApi.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false, format: 'log' },
      new AbortController().signal,
    )
    const storedBytes = await responseBytes(uncompressed)
    const compressedBytes = await responseBytes(compressed)
    expect(compressedBytes.byteLength).toBeLessThan(storedBytes.byteLength)
    expect(strFromU8(unzipSync(compressedBytes)[exportLogName] as Uint8Array)).toBe(logText(stored))
  })

  it('includes descendant logs under subagents/<id>/ when requested', async () => {
    const child = log('child-a', sid('session-root'))
    const api = await buildApi({
      'session-root': log('session-root'),
      'child-a': child,
      'grandchild-a': log('grandchild-a', sid('child-a')),
    }, [
      node('child-a', node('grandchild-a')),
    ])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      exportLogName,
      subagentLogName('child-a'),
      subagentLogName('grandchild-a'),
    ])
    expect(strFromU8(files[subagentLogName('child-a')] as Uint8Array))
      .toBe(logText(child))
  })

  it('flushes each live root and descendant immediately before reading its log', async () => {
    const staleMarker = { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } } as SessionEvent
    const durableMarker = { type: 'turn/start', seq: SessionSeq(0), time: 2, data: { turn: 1 } } as SessionEvent
    const stored: Record<string, StoredLog> = {
      'session-root': log('session-root', undefined, [staleMarker]),
      'child-a': log('child-a', sid('session-root'), [staleMarker]),
    }
    const durable: Record<string, StoredLog> = {
      'session-root': log('session-root', undefined, [durableMarker]),
      'child-a': log('child-a', sid('session-root'), [durableMarker]),
    }
    const flushed: SessionId[] = []
    const api = await buildApi(stored, [node('child-a')], {
      sessions: {
        get: id => durable[id] === undefined ? undefined : { id },
        flush: async (session) => {
          const logAfterFlush = durable[session.id]
          if (logAfterFlush === undefined) throw new Error('unexpected session')
          flushed.push(session.id)
          stored[session.id] = logAfterFlush
          return true
        },
      },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(flushed).toEqual([sid('session-root'), sid('child-a')])
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(logText(durable['session-root'] as StoredLog))
    expect(strFromU8(files[subagentLogName('child-a')] as Uint8Array)).toBe(logText(durable['child-a'] as StoredLog))
  })

  it('reads a cold log without asking the live-session store to flush', async () => {
    const flush = vi.fn(async () => true)
    const stored = log('session-root')
    const api = await buildApi({ 'session-root': stored }, [], {
      sessions: {
        get: () => undefined,
        flush,
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false, format: 'log' },
      new AbortController().signal,
    )
    const files = unzipSync(await responseBytes(response))
    expect(flush).not.toHaveBeenCalled()
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(logText(stored))
  })

  it('answers 404 for a session the backend does not store', async () => {
    const api = await buildApi({})
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('session not found')
  })

  it('answers 400 when the sessionId query parameter is absent', async () => {
    const api = await buildApi({ 'session-root': log('session-root') })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&includeDescendants=true'),
    )
    expect(response.status).toBe(400)
  })

  it('answers 400 for an includeDescendants value other than true or false', async () => {
    const api = await buildApi({ 'session-root': log('session-root') })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=1'),
    )
    expect(response.status).toBe(400)
  })

  it('answers 500 when the deployment mounts no persistence or session-query service', async () => {
    const api = await buildApi({}, [], { query: false, persistence: false })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('session-query')
  })

  it('fails the whole export when a descendant has no stored log', async () => {
    const api = await buildApi({
      'session-root': log('session-root'),
    }, [node('child-missing')])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    expect(response.status).toBe(200)
    // The stream errors before completing, so the body read rejects rather
    // than returning a truncated-but-valid archive.
    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  it('keeps an astral character whole when its surrogate pair straddles a push boundary', async () => {
    // The push loop slices by 2^16 code units and must back off one unit when
    // the boundary lands inside a surrogate pair; otherwise the pair re-encodes
    // as U+FFFD and the exported log is silently corrupted.
    const content = `${'a'.repeat((1 << 16) - 1)}😀tail`
    const files = await directZipFiles(content)
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(content)
  })

  it('splits a long log on a plain code-unit boundary without backoff', async () => {
    // A boundary that lands on a BMP character needs no surrogate backoff; the
    // round trip must still be byte-identical across the multi-chunk push.
    const content = 'z'.repeat((1 << 16) + 4096)
    const files = await directZipFiles(content)
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe(content)
  })

  it('streams an empty root text as an empty zip entry', async () => {
    const files = await directZipFiles('')
    expect(Object.keys(files)).toEqual([exportLogName])
    expect(strFromU8(files[exportLogName] as Uint8Array)).toBe('')
  })

  it('waits for response pull capacity before reading the next archive entry', async () => {
    const filler = {
      type: 'user/message', seq: SessionSeq(2), time: 1000,
      data: { content: [{ type: 'text', text: randomBytes(512 * 1024).toString('base64') }] },
    } as unknown as SessionEvent
    const stored = log('session-root', undefined, [imageEvent('after-root'), filler])
    let imageReads = 0
    const api = await buildApi({ 'session-root': stored }, [], {
      attachments: async (ref) => {
        imageReads += 1
        return storedImage(String(ref.attachmentId), ref.mediaType)
      },
    })
    vi.useFakeTimers()
    let response: Response | undefined
    try {
      response = await toFetchHandler(api).fetch(
        new Request('http://host/api/session.export?format=log&sessionId=session-root'),
      )
      // Exhausting timer turns must not advance a producer whose byte queue is
      // full; only a consumer pull can release it.
      await vi.runAllTimersAsync()
      expect(imageReads).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    if (response === undefined) throw new Error('missing export response')
    const files = unzipSync(await responseBytes(response))
    expect(imageReads).toBe(1)
    expect(files['media/after-root.png']).toEqual(storedImage('after-root').data)
  })

  it('exports a shared lineage node once (seen-set dedup)', async () => {
    const api = await buildApi({
      'session-root': log('session-root'),
      'child-a': log('child-a', sid('session-root')),
      'child-b': log('child-b', sid('session-root')),
      shared: log('shared', sid('child-a')),
    }, [
      node('child-a', node('shared')),
      node('child-b', node('shared')),
    ])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      exportLogName,
      subagentLogName('child-a'),
      subagentLogName('child-b'),
      subagentLogName('shared'),
    ])
  })

  it('answers 500 without leaking the backend error when the root read fails', async () => {
    const api = await buildApi({}, [], { query: true, persistence: 'throw' })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe('session log export failed to read the stored log')
    expect(body).not.toContain('/host/private/')
  })

  it('answers the private-error-safe 500 when the live root flush fails', async () => {
    const api = await buildApi({ 'session-root': log('session-root') }, [], {
      sessions: {
        get: id => ({ id }),
        flush: async () => { throw new Error('/host/private/flush-state') },
      },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toBe('session log export failed to read the stored log')
    expect(body).not.toContain('/host/private/')
  })

  it('refuses a live root when no durability listener confirms the flush', async () => {
    const open = vi.fn(async () => readHandle(log('session-root')))
    const api = await buildApi({ 'session-root': log('session-root') }, [], {
      sessions: {
        get: id => ({ id }),
        flush: async () => false,
      },
      open,
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('session log export failed to read the stored log')
    expect(open).not.toHaveBeenCalled()
  })

  it('fails the ZIP stream before reading a live descendant without a durability listener', async () => {
    const opened: SessionId[] = []
    const api = await buildApi({
      'session-root': log('session-root'),
      'child-a': log('child-a', sid('session-root')),
    }, [node('child-a')], {
      sessions: {
        get: id => id === sid('child-a') ? { id } : undefined,
        flush: async () => false,
      },
      open: async (id) => {
        opened.push(id)
        return readHandle(id === sid('session-root')
          ? log('session-root')
          : log('child-a', sid('session-root')))
      },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('no durability listener for export')
    expect(opened).toEqual([sid('session-root')])
  })

  it('forwards one request signal through root, lineage, and descendant reads', async () => {
    const reads: Array<{ id: SessionId; signal: AbortSignal | undefined }> = []
    const traces: AbortSignal[] = []
    const api = await buildApi({}, [node('child-a')], {
      open: async (id, _access, options) => {
        reads.push({ id, signal: options?.signal })
        return readHandle(id === sid('session-root')
          ? log('session-root')
          : log('child-a', sid('session-root')))
      },
      traceSession: async (_id, signal) => {
        if (signal !== undefined) traces.push(signal)
        return {
          target: { header: header('session-root'), live: false, persisted: true },
          ancestors: [],
          complete: true,
          root: { header: header('session-root'), live: false, persisted: true },
          descendants: [node('child-a')],
        }
      },
    })
    const controller = new AbortController()
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true, format: 'log' },
      controller.signal,
    )
    await response.arrayBuffer()
    const rootSignal = reads[0]?.signal
    if (rootSignal === undefined) throw new Error('missing root signal')
    const producerSignal = traces[0]
    if (producerSignal === undefined) throw new Error('missing lineage signal')
    expect(reads[0]?.id).toBe(sid('session-root'))
    expect(reads[1]).toEqual({ id: sid('child-a'), signal: producerSignal })
    const cancellation = new Error('request cancelled after response')
    controller.abort(cancellation)
    expect(rootSignal.aborted).toBe(true)
    expect(rootSignal.reason).toBe(cancellation)
    expect(producerSignal.aborted).toBe(true)
    expect(producerSignal.reason).toBe(cancellation)
  })

  it('preserves request cancellation instead of translating it to HTTP 500', async () => {
    const api = await buildApi({ 'session-root': log('session-root') })
    const controller = new AbortController()
    const cancellation = new Error('request cancelled')
    controller.abort(cancellation)
    await expect(api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false, format: 'log' },
      controller.signal,
    )).rejects.toBe(cancellation)
  })

  it('aborts descendant work and terminates ZIP production when its reader cancels', async () => {
    let reportDescendantStarted!: (signal: AbortSignal) => void
    const descendantStarted = new Promise<AbortSignal>((resolve) => {
      reportDescendantStarted = resolve
    })
    const api = await buildApi({}, [node('child-a')], {
      open: async (id, _access, options) => {
        if (id === sid('session-root')) return readHandle(log('session-root'))
        const signal = options?.signal
        if (signal === undefined) throw new Error('missing descendant signal')
        reportDescendantStarted(signal)
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error)
          }, { once: true })
        })
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true, format: 'log' },
      new AbortController().signal,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const descendantSignal = await descendantStarted
    const cancellation = new Error('download consumer left')
    await reader.cancel(cancellation)
    expect(descendantSignal.aborted).toBe(true)
    expect(descendantSignal.reason).toBe(cancellation)
  })

  it('aborts attachment reads when its reader cancels', async () => {
    let reportAttachmentStarted!: (signal: AbortSignal) => void
    const attachmentStarted = new Promise<AbortSignal>((resolve) => {
      reportAttachmentStarted = resolve
    })
    const stored = log('session-root', undefined, [imageEvent('slow-img')])
    const api = await buildApi({ 'session-root': stored }, [], {
      attachments: async (_ref, signal) => {
        if (signal === undefined) throw new Error('missing attachment signal')
        reportAttachmentStarted(signal)
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error)
          }, { once: true })
        })
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: false, format: 'log' },
      new AbortController().signal,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const attachmentSignal = await attachmentStarted
    const cancellation = new Error('download consumer left during attachment read')
    await reader.cancel(cancellation)
    expect(attachmentSignal.aborted).toBe(true)
    expect(attachmentSignal.reason).toBe(cancellation)
  })

  it('uses a stable Error reason when its reader cancels without one', async () => {
    let reportDescendantStarted!: (signal: AbortSignal) => void
    const descendantStarted = new Promise<AbortSignal>((resolve) => {
      reportDescendantStarted = resolve
    })
    const api = await buildApi({}, [node('child-a')], {
      open: async (id, _access, options) => {
        if (id === sid('session-root')) return readHandle(log('session-root'))
        const signal = options?.signal
        if (signal === undefined) throw new Error('missing descendant signal')
        reportDescendantStarted(signal)
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error)
          }, { once: true })
        })
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true, format: 'log' },
      new AbortController().signal,
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('missing response body')
    const descendantSignal = await descendantStarted
    await reader.cancel()
    expect(descendantSignal.reason).toEqual(new Error('session log export stream cancelled'))
  })

  it('normalizes a non-Error descendant failure before erroring the stream', async () => {
    const api = await buildApi({}, [node('child-a')], {
      open: async (id) => {
        if (id === sid('session-root')) return readHandle(log('session-root'))
        throw 'descendant read failed'
      },
    })
    const response = await api.downloads.sessionLog(
      { sessionId: sid('session-root'), includeDescendants: true, format: 'log' },
      new AbortController().signal,
    )
    await expect(response.arrayBuffer()).rejects.toEqual(new Error('descendant read failed'))
  })

  it('includes media objects referenced by the root log under media/<id>.<ext>', async () => {
    const stored = log('session-root', undefined, [imageEvent('img-1')])
    const api = await buildApi({ 'session-root': stored })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual(['media/img-1.png', exportLogName].sort())
    expect(files['media/img-1.png']).toEqual(storedImage('img-1').data)
  })

  it('streams generic files under their content-addressed archive paths', async () => {
    const digest = 'a'.repeat(64)
    const id = `sha256:${digest}`
    const fallbackDigest = 'c'.repeat(64)
    const fallbackId = `sha256:${fallbackDigest}`
    const root = log('session-root', undefined, [
      fileEvent(id, 'notes.txt', 5),
      fileEvent(fallbackId, '.', 5, SessionSeq(2)),
    ])
    const reads: Array<{ ref: FileAttachmentRef; signal: AbortSignal | undefined }> = []
    const api = await buildApi({ 'session-root': root }, [], {
      readFileStream: (ref, signal) => (async function* (): AsyncIterable<Uint8Array> {
        reads.push({ ref, signal })
        yield new Uint8Array()
        yield Uint8Array.of(1, 2)
        yield Uint8Array.of(3, 4, 5)
      })(),
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(files[`files/aa/${digest}/notes.txt`]).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    expect(files[`files/cc/${fallbackDigest}/file`]).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    expect(reads).toHaveLength(2)
    expect(reads[0]?.ref).toMatchObject({ attachmentId: id, name: 'notes.txt', bytes: 5 })
    expect(reads[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('exports the full audit blob once across sessions with their own receipts', async () => {
    const data = Buffer.from('{"prompt":"SECRET_API_KEY, unredacted context"}')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const reads = vi.fn()
    const root = log('session-root', undefined, auditArtifactEvents(sha256, data.length))
    const child = log('child-a', sid('session-root'), auditArtifactEvents(sha256, data.length, 'thread-2'))
    const api = await buildApi({ 'session-root': root, 'child-a': child }, [node('child-a')], {
      readFileStream: ref => (async function* (): AsyncIterable<Uint8Array> {
        reads(ref)
        yield data.subarray(0, 12)
        yield data.subarray(12)
      })(),
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(files[`audit/${sha256}.blob`]).toEqual(new Uint8Array(data))
    expect(Object.keys(files).filter(path => path.startsWith('audit/'))).toHaveLength(1)
    expect(reads).toHaveBeenCalledOnce()
    expect(reads.mock.calls[0]?.[0]).toMatchObject({
      attachmentId: `sha256:${sha256}`, name: `dsh-audit-${sha256}.blob`, bytes: data.length,
    })
  })

  it('rejects audit gaps, reused event IDs, and an unresolved compaction in any included log', async () => {
    const failure = (sequence: number, eventId: string): SessionEvent => ({
      type: 'codex/audit-v1', seq: SessionSeq(sequence - 1), time: 1000,
      data: { version: 1, sequence, eventId, time: 1000, threadId: 'thread-1', turn: 1,
        kind: 'model/failure', attemptId: `attempt-${sequence}`, purpose: 'inference',
        stage: 'codex', message: 'upstream failed' },
    })
    const pending: SessionEvent = { type: 'codex/audit-v1', seq: SessionSeq(0), time: 1000,
      data: { version: 1, sequence: 1, eventId: 'pending-1', time: 1000, threadId: 'thread-1',
        turn: 1, kind: 'compaction/pending', compactionId: 'compaction-1',
        effectiveHistory: { kind: 'inline', value: [] }, priorRolloutSha256: 'a'.repeat(64) },
    }
    for (const [events, message] of [
      [[failure(2, 'failure-2')], 'sequence, event ID, or thread'],
      [[failure(1, 'same-id'), failure(2, 'same-id')], 'sequence, event ID, or thread'],
      [[pending], 'compaction compaction-1 is incomplete'],
    ] as const) {
      const api = await buildApi({ 'session-root': log('session-root', undefined, events) })
      const response = await api.downloads.sessionLog({ sessionId: sid('session-root'),
        includeDescendants: false, format: 'log' }, new AbortController().signal)
      await expect(response.arrayBuffer()).rejects.toThrow(message)
    }
    const descendant = await buildApi({
      'session-root': log('session-root'),
      'child-a': log('child-a', sid('session-root'), [failure(2, 'failure-2')]),
    }, [node('child-a')])
    const response = await descendant.downloads.sessionLog({ sessionId: sid('session-root'),
      includeDescendants: true, format: 'log' }, new AbortController().signal)
    await expect(response.arrayBuffer()).rejects.toThrow('sequence, event ID, or thread')
  })

  it('verifies the V2 checkpoint inside a valid audit blob before completing export', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../core/agent-codex/tests/fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as Record<string, unknown>
    for (const [snapshot, valid, installedCount] of [
      [fixture, true, 2],
      [{ ...fixture, effectiveHistory: [] }, false, 2],
      [fixture, false, 1],
    ] as const) {
      const data = Buffer.from(JSON.stringify(snapshot))
      const sha256 = createHash('sha256').update(data).digest('hex')
      const facts: SessionEvent[] = [{ type: 'codex/artifact-v1', seq: SessionSeq(0), time: 1, data: {
        version: 1, threadId: 'thread-1', sha256, bytes: data.length, mediaType: 'application/json',
        name: `dsh-audit-${sha256}.blob`,
      } }]
      const fact = (sequence: number, data: Record<string, unknown>): void => {
        facts.push({ type: 'codex/audit-v1', seq: SessionSeq(sequence), time: 1, data: {
          version: 1, sequence, eventId: `event-${sequence}`, time: 1, threadId: 'thread-1', turn: 1,
          ...data,
        } } as SessionEvent)
      }
      fact(1, { kind: 'context/config', config: { kind: 'inline', value: fixture.contextConfig } })
      const compactions = fixture.compactions as { id: string; replacementHistory: unknown[] }[]
      for (const [index, compaction] of compactions.slice(0, installedCount).entries()) {
        const sequence = 2 + index * 2
        fact(sequence, { kind: 'compaction/pending', compactionId: compaction.id,
          effectiveHistory: { kind: 'inline', value: compaction.replacementHistory },
          priorRolloutSha256: 'a'.repeat(64) })
        fact(sequence + 1, { kind: 'compaction/installed', compactionId: compaction.id,
          effectiveHistory: { kind: 'inline', value: compaction.replacementHistory } })
      }
      fact(2 + installedCount * 2, { kind: 'checkpoint', checkpointId: 'turn:turn-1',
        effectiveHistorySha256: fixture.effectiveHistorySha256,
        snapshot: { kind: 'artifact', sha256, bytes: data.length, mediaType: 'application/json' } })
      const api = await buildApi({ 'session-root': log('session-root', undefined, facts) }, [], {
        readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
          for (let offset = 0; offset < data.byteLength; offset += 97) {
            yield data.subarray(offset, offset + 97)
          }
        })(),
      })
      const response = await api.downloads.sessionLog(
        { sessionId: sid('session-root'), includeDescendants: false, format: 'log' }, new AbortController().signal,
      )
      if (valid) {
        expect(unzipSync(await responseBytes(response))[`audit/${sha256}.blob`]).toEqual(new Uint8Array(data))
      } else {
        await expect(response.arrayBuffer()).rejects.toThrow()
      }
    }
  })

  it('rejects an audit reference without a receipt in that Session', async () => {
    const data = Buffer.from('full result')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const [, fact] = auditArtifactEvents(sha256, data.length)
    const api = await buildApi({ 'session-root': log('session-root', undefined, fact === undefined ? [] : [fact]) })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    await expect(response.arrayBuffer()).rejects.toThrow('no matching Session receipt')
  })

  it('rejects missing or altered audit blobs instead of exporting a truncated ZIP', async () => {
    const data = Buffer.from('full audit payload')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const root = log('session-root', undefined, auditArtifactEvents(sha256, data.length))
    for (const readFileStream of [
      () => (async function* (): AsyncIterable<Uint8Array> { throw new Error('blob missing') })(),
      () => (async function* (): AsyncIterable<Uint8Array> { yield Buffer.from('altered audit data') })(),
    ]) {
      const api = await buildApi({ 'session-root': root }, [], { readFileStream })
      const response = await toFetchHandler(api).fetch(
        new Request('http://host/api/session.export?format=log&sessionId=session-root'),
      )
      await expect(response.arrayBuffer()).rejects.toThrow()
    }
  })

  it('fails the whole export when a referenced file stream fails', async () => {
    const digest = 'b'.repeat(64)
    const id = `sha256:${digest}`
    const root = log('session-root', undefined, [fileEvent(id)])
    const api = await buildApi({ 'session-root': root }, [], {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1)
        throw new Error('file bytes missing')
      })(),
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    await expect(response.arrayBuffer()).rejects.toThrow('file bytes missing')
  })

  it('collects media referenced from nested tool results', async () => {
    const nested = {
      type: 'assistant/message', seq: SessionSeq(2), time: 2000,
      data: { content: [{ type: 'tool-result', content: [{ type: 'image', attachment: { attachmentId: 'nested-1', mediaType: 'image/webp', bytes: 4, width: 2, height: 2 } }] }] },
    } as unknown as SessionEvent
    const api = await buildApi({ 'session-root': log('session-root', undefined, [nested]) })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual(['media/nested-1.webp', exportLogName].sort())
  })

  it('scans wrapped, inserted, and embedded-stream carriers plus non-object content items', async () => {
    const block = (id: string, mediaType: string): unknown =>
      ({ type: 'image', attachment: { attachmentId: id, mediaType, bytes: 4, width: 2, height: 2 } })
    const wrapped = {
      type: 'assistant/message', seq: SessionSeq(2), time: 2000,
      data: { message: { role: 'assistant', content: ['noise', block('wrapped-1', 'image/jpeg')] } },
    } as unknown as SessionEvent
    const inserted = {
      type: 'context/inserted', seq: SessionSeq(3), time: 3000,
      data: { inserted: [{ content: [block('inserted-1', 'image/gif')] }] },
    } as unknown as SessionEvent
    const attempt = {
      type: 'assistant/attempt', seq: SessionSeq(4), time: 4000,
      data: {
        stream: [
          { type: 'text-chunks', time0: 3999, index: 0, dt: [], texts: ['ignored'] },
          { type: 'chunk', time: 4000, chunk: { type: 'finish', reason: { kind: 'stop' } } },
          {
            type: 'chunk', time: 4000,
            chunk: { type: 'block-end', block: block('stream-1', 'image/png') },
          },
        ],
      },
    } as unknown as SessionEvent
    const api = await buildApi({ 'session-root': log('session-root', undefined, [wrapped, inserted, attempt]) })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(Object.keys(files).sort()).toEqual([
      'media/inserted-1.gif',
      'media/stream-1.png',
      'media/wrapped-1.jpg',
      exportLogName,
    ])
  })

  it('deduplicates one media object referenced by several included logs', async () => {
    const root = log('session-root', undefined, [imageEvent('shared-img')])
    const child = log('child-a', sid('session-root'), [imageEvent('shared-img')])
    const api = await buildApi({ 'session-root': root, 'child-a': child }, [node('child-a')])
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    const files = unzipSync(await responseBytes(response))
    expect(files['media/shared-img.png']).toEqual(storedImage('shared-img').data)
    expect(Object.keys(files).filter(name => name.startsWith('media/'))).toEqual(['media/shared-img.png'])
  })

  it.each(['log', 'portable'] as const)('refuses cross-session image and file metadata conflicts in %s export', async (format) => {
    for (const [rootEvent, childEvent, message] of [
      [imageEvent('shared-img'), imageEvent('shared-img', 'image/jpeg'), 'conflicting image attachment metadata'],
      [fileEvent('shared-file', 'notes.txt', 5), fileEvent('shared-file', 'notes.txt', 6), 'conflicting file attachment metadata'],
    ] as const) {
      const api = await buildApi({
        'session-root': log('session-root', undefined, [standardDriverSelected, rootEvent]),
        'child-a': log('child-a', sid('session-root'), [childEvent]),
      }, [node('child-a')], { portableBundle: portableBundle() })
      const response = await api.downloads.sessionLog({ sessionId: sid('session-root'), includeDescendants: true, format },
        new AbortController().signal)
      expect(response.status).toBe(200)
      await expect(response.arrayBuffer()).rejects.toThrow(message)
    }
  })

  it('includes descendant media only when descendants are requested', async () => {
    const child = log('child-a', sid('session-root'), [imageEvent('child-img')])
    const api = await buildApi({ 'session-root': log('session-root'), 'child-a': child }, [node('child-a')])
    const without = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(Object.keys(unzipSync(await responseBytes(without)))).toEqual([exportLogName])
    const withDescendants = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root&includeDescendants=true'),
    )
    expect(Object.keys(unzipSync(await responseBytes(withDescendants))).sort()).toEqual([
      'media/child-img.png',
      exportLogName,
      subagentLogName('child-a'),
    ])
  })

  it('fails the whole export when a referenced image cannot be read', async () => {
    const stored = log('session-root', undefined, [imageEvent('gone-img')])
    const api = await buildApi({ 'session-root': stored }, [], {
      attachments: async () => { throw new Error('attachment bytes missing') },
    })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('attachment bytes missing')
  })

  it('answers 500 when the deployment mounts no attachments service', async () => {
    const api = await buildApi({ 'session-root': log('session-root') }, [], { attachments: false })
    const response = await toFetchHandler(api).fetch(
      new Request('http://host/api/session.export?format=log&sessionId=session-root'),
    )
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('attachments')
  })
})
