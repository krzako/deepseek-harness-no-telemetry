/** Session-log download command and Host-owned streaming route. */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from './archive.ts'
import { captureDshWorkspaceExport } from './workspace-export.ts'
import { sourceCwd, exportDriverId, portableSessionZipEntries, validatePortableArchiveBundle } from './portable-archive.ts'
import { handleDshImportPreview } from './import-preview-route.ts'
import type { DshArchiveResourcePolicy } from './manifest-stream.ts'

export {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  serializeSessionLog,
  SESSION_LOG_FILENAME,
  sessionLogExportDeps,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './archive.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './archive.ts'
export * from './manifest.ts'
export * from './zip-validation.ts'
export * from './archive-logs.ts'
export * from './archive-bundle.ts'
export { resolveDshArchiveAttachments } from './archive-attachments.ts'
export * from './restore-attachments.ts'
export * from './archive-projection.ts'
export * from './archive-preview.ts'
export * from './archive-import.ts'
export * from './workspace-preview.ts'
export * from './workspace-conflicts.ts'
export * from './workspace-fingerprint.ts'
export * from './workspace-export.ts'
export { inspectDshWorkspaceBackup } from './workspace-backup.ts'
export type { DshWorkspaceBackup, DshWorkspaceBackupRecord } from './workspace-backup.ts'
export { inspectDshWorkspaceImport, retainDshWorkspaceImport } from './workspace-recovery.ts'
export type { DshWorkspaceImportRecord, DshWorkspaceImportRecovery } from './workspace-recovery.ts'
export * from './manifest-stream.ts'
export * from './portable-archive.ts'

export const name = 'session-log-download'
export const inject = ['commands', 'connection']

/** Stable browser download path retained across the transport migration. */
export const SESSION_LOG_EXPORT_PATH = '/api/session.export'

/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
  /** Optional maximum uncompressed bytes in one portable ZIP entry. */
  readonly maxPortableEntryBytes?: number
  /** Optional maximum uncompressed bytes across all portable ZIP entries. */
  readonly maxPortableTotalUncompressedBytes?: number
  /** Optional maximum compressed bytes accepted by import preview. */
  readonly maxImportArchiveBytes?: number
  /** Optional maximum entry count in an uploaded ZIP. */
  readonly maxImportEntries?: number
  /** Optional maximum bytes in one decompressed import entry. */
  readonly maxImportEntryBytes?: number
  /** Optional maximum bytes across decompressed import entries. */
  readonly maxImportTotalUncompressedBytes?: number
}

/** Validate Session-log archive configuration. */
export const Config: Schema<Config> = Schema.object({
  compressionLevel: Schema.number().step(1).min(0).max(9)
    .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as Schema<SessionLogCompressionLevel>,
  maxImportArchiveBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  maxImportEntries: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  maxImportEntryBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  maxImportTotalUncompressedBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  maxPortableEntryBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  maxPortableTotalUncompressedBytes: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/**
 * Register the Web-only `/export` command and authenticated ZIP download route.
 * @param ctx - Host context carrying the human-command registry.
 * @param config - resolved compression and optional portable resource policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  connectionOf(ctx).fetch.register({
    path: '/api/session.import.preview',
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: request => handleDshImportPreview(request, ctx.get('agents'), {
      ...config.maxImportArchiveBytes === undefined ? {} : { maxArchiveBytes: config.maxImportArchiveBytes },
      ...config.maxImportEntries === undefined ? {} : { maxEntries: config.maxImportEntries },
      ...config.maxImportEntryBytes === undefined ? {} : { maxEntryBytes: config.maxImportEntryBytes },
      ...config.maxImportTotalUncompressedBytes === undefined ? {} : { maxTotalUncompressedBytes: config.maxImportTotalUncompressedBytes },
    }),
  })
  ctx.effect(() => ctx.commands.register({
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionLogExportResponse(
        ctx,
        request,
        config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
        { ...config.maxPortableEntryBytes === undefined ? {} : { maxEntryBytes: config.maxPortableEntryBytes },
          ...config.maxPortableTotalUncompressedBytes === undefined
            ? {} : { maxTotalUncompressedBytes: config.maxPortableTotalUncompressedBytes } },
      )
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
}

function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection') as SessionLogConnection
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
  resourcePolicy: DshArchiveResourcePolicy,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  const format = query['format'] ?? 'portable'
  const workspaceValue = query['includeWorkspace']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')
    || (workspaceValue !== undefined && workspaceValue !== 'true' && workspaceValue !== 'false')
    || (workspaceValue === 'true' && format !== 'portable')
    || (format !== 'portable' && format !== 'log')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  let portableEntries: ((signal: AbortSignal) => ReturnType<typeof portableSessionZipEntries>) | undefined
  if (format === 'portable') {
    try {
      const driverId = exportDriverId(rootContent)
      const agents = ctx.get('agents')
      if (agents === undefined) throw new Error('agent registry is unavailable')
      const source = agents.getTransferPorts(driverId).source
      const bundle = await (source.exportPortableContextStream === undefined
        ? source.exportPortableContext(sessionId)
        : source.exportPortableContextStream(sessionId))
      validatePortableArchiveBundle(bundle, sessionId, driverId)
      await flushLiveSessionLog(deps, sessionId, request.signal)
      const verifiedRoot = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
      request.signal.throwIfAborted()
      if (verifiedRoot !== rootContent) {
        return new Response('session changed during portable export; retry the download', { status: 409 })
      }
      const workspace = workspaceValue === 'true'
        ? await captureDshWorkspaceExport(sourceCwd(rootContent), request.signal) : undefined
      portableEntries = signal => portableSessionZipEntries(
        ready, rootContent, sessionId, descendantsValue === 'true', bundle, resourcePolicy, signal, workspace,
      )
    } catch {
      request.signal.throwIfAborted()
      return new Response(workspaceValue === 'true'
        ? 'portable workspace export unavailable: requires a stable readable workspace with only regular files, directories and portable paths'
        : 'portable session export is unavailable for this driver or session', { status: 409 })
    }
  }
  const response = new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      descendantsValue === 'true',
      compressionLevel,
      request.signal,
      portableEntries,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
      },
    },
  )
  return response
}
