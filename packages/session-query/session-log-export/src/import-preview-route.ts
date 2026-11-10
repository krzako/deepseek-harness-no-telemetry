/** Authenticated, read-only archive upload and compatibility preview. */

import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { previewDshSessionArchive } from './archive-preview.ts'
import { DshArchiveManifestRequiredError, type DshZipValidationPolicy } from './zip-validation.ts'

/** Optional operator limits; absent limits impose no global archive-size ceiling. */
export interface DshImportPreviewPolicy extends DshZipValidationPolicy {
  readonly maxArchiveBytes?: number
}

class UploadLimitError extends Error {}

async function writeUpload(
  body: ReadableStream<Uint8Array>, signal: AbortSignal, path: string, policy: DshImportPreviewPolicy,
): Promise<void> {
  const reader = body.getReader()
  const abort = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const file = await open(path, 'wx', 0o600)
    try {
      let bytes = 0
      while (true) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (!Number.isSafeInteger(bytes) || policy.maxArchiveBytes !== undefined && bytes > policy.maxArchiveBytes) {
          throw new UploadLimitError('archive upload exceeds operator policy')
        }
        await file.writeFile(chunk.value)
      }
    } finally { await file.close() }
  } finally {
    signal.removeEventListener('abort', abort)
    // Cancellation failure must not hide the original read/write/validation error.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** Receive one authorized ZIP and return compatibility without creating a Session.
 * Staging is private, exclusive and removed on success, failure or cancellation.
 * No path from the HTTP request selects the staging file; target workspace is
 * inspected only after complete ZIP, context and source-projection validation.
 * The response describes compatibility and contains no import authorization token.
 * A later import must upload and validate its own archive again.
 * @param request - authenticated raw application/zip POST from Connection.
 * @param agents - installed driver registry, or undefined when unavailable.
 * @param policy - optional compressed and decompressed resource limits.
 * @returns no-store JSON report or a public error without host diagnostics.
 */
export async function handleDshImportPreview(
  request: Request,
  agents: Pick<AgentRegistry, 'getTransferPorts'> | undefined,
  policy: DshImportPreviewPolicy = {},
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/zip') {
    return json({ error: 'archive-content-type', message: 'Preview requires an unencrypted application/zip archive.' }, 415)
  }
  const params = new URL(request.url).searchParams
  const driverId = params.get('driverId')
  const provider = params.get('provider')
  const model = params.get('model')
  if (!driverId || !provider || !model || request.body === null
    || [...params.keys()].some(key => !['driverId', 'provider', 'model', 'workspace'].includes(key) || params.getAll(key).length !== 1)) {
    return json({ error: 'archive-preview-request', message: 'Select one destination driver and model and upload a ZIP.' }, 400)
  }
  if (agents === undefined) return json({ error: 'archive-drivers-unavailable', message: 'Agent drivers are unavailable.' }, 503)
  request.signal.throwIfAborted()
  const staging = await mkdtemp(join(tmpdir(), 'dsh-import-preview-'))
  try {
    const path = join(staging, 'archive.zip')
    await writeUpload(request.body, request.signal, path, policy)
    const preview = await previewDshSessionArchive(path, sessionFormatCatalog,
      sourceId => agents.getTransferPorts(sourceId).source,
      agents.getTransferPorts(driverId).target, { provider, id: model }, policy, request.signal, params.get('workspace'))
    request.signal.throwIfAborted()
    return json({
      source: preview.bundle.context.source,
      logs: preview.logs.map(log => ({ sessionId: log.artifact.header.id, storedVersion: log.storedVersion })),
      targetDriverId: preview.targetDriverId, targetModel: preview.targetModel,
      authentication: preview.authentication, assessment: preview.assessment,
      workspace: preview.workspace, workspaceEntries: preview.workspaceEntries,
    })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    if (error instanceof UploadLimitError) return json({ error: 'archive-upload-limit', message: error.message }, 413)
    if (error instanceof DshArchiveManifestRequiredError) {
      return json({ error: error.code, message: 'This log-only archive has no portable Session manifest.' }, 422)
    }
    return json({ error: 'archive-preview-failed',
      message: 'Cannot preview this archive with the selected driver, model and workspace. No Session was created.' }, 422)
  } finally { await rm(staging, { recursive: true, force: true }) }
}
