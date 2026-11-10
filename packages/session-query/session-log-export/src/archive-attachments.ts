/** Match durable and canonical attachment references to verified archive receipts. */

import { portableAttachmentKey, type PortableContentBlockV1 } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { DshArchiveBundlePreview } from './archive-bundle.ts'
import type { DshArchiveEntryV1, DshSessionArchiveManifestV1 } from './manifest.ts'
import { attachmentRefsInEvents, fileEntryPath, mediaEntryPath } from './archive.ts'

function imageMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function digest(id: string): string {
  const value = id.replace(/^sha256:/u, '')
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('session import: invalid content-addressed attachment id')
  return value
}

/** Check every durable and canonical reference without reading or publishing bytes.
 * The supplied manifest must already match fully measured ZIP payloads.
 * @param preview - complete decoded logs and schema-validated canonical context.
 * @param manifest - verified payload receipts from the same archive.
 */
export function validateDshArchiveAttachments(
  preview: DshArchiveBundlePreview,
  manifest: DshSessionArchiveManifestV1,
): void {
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]))
  const requireEntry = (path: string, id: string, bytes?: number, file = false): DshArchiveEntryV1 => {
    const entry = entries.get(path)
    if (entry?.kind !== 'attachment' || (bytes !== undefined && entry.bytes !== bytes)
      || ((file || id.startsWith('sha256:')) && entry.sha256 !== digest(id))) {
      throw new Error(`session import: missing or inconsistent attachment ${path}`)
    }
    return entry
  }
  const events = function* () { for (const log of preview.logs) yield* log.artifact.events }
  const refs = attachmentRefsInEvents(events())
  for (const ref of refs.images.values()) {
    if (!imageMediaType(ref.mediaType)) throw new Error('session import: unsupported image media type')
    requireEntry(mediaEntryPath(String(ref.attachmentId), ref.mediaType), String(ref.attachmentId), ref.bytes)
  }
  for (const ref of refs.files.values()) {
    requireEntry(fileEntryPath(String(ref.attachmentId), ref.name), String(ref.attachmentId), ref.bytes, true)
  }
  const visit = (blocks: readonly PortableContentBlockV1[]): void => {
    for (const block of blocks) {
      if (block.kind === 'tool-result') visit(block.content)
      if (block.kind !== 'attachment') continue
      if (imageMediaType(block.mediaType)) {
        requireEntry(mediaEntryPath(block.attachmentId, block.mediaType), block.attachmentId)
      } else {
        if (block.mediaType.startsWith('image/')) throw new Error('session import: unsupported image media type')
        const hash = digest(block.attachmentId)
        if (block.name !== undefined) {
          requireEntry(fileEntryPath(block.attachmentId, block.name), block.attachmentId, undefined, true)
        } else if (!manifest.entries.some(entry => entry.kind === 'attachment'
          && entry.path.startsWith(`files/${hash.slice(0, 2)}/${hash}/`) && entry.sha256 === hash)) {
          throw new Error(`session import: missing canonical file attachment ${block.attachmentId}`)
        }
      }
    }
  }
  for (const item of preview.bundle.context.items) visit(item.content)
}


/** Resolve canonical references from validated archive logs without publishing bytes.
 * Images share encoded metadata by id while their display names come from canonical
 * context. Files with omitted names require exactly one logged candidate. Full keys
 * preserve identical bytes used as image/file or under several explicit names.
 * Missing metadata and ambiguity reject rather than guessing a reference. The caller
 * must separately restore bytes before passing this map to an import publisher.
 * @param preview - validated canonical context and complete decoded Session logs.
 * @param manifest - verified attachment receipts from the same archive.
 * @returns detached references keyed by portableAttachmentKey for target projection.
 */
export function resolveDshArchiveAttachments(
  preview: DshArchiveBundlePreview,
  manifest: DshSessionArchiveManifestV1,
): ReadonlyMap<string, Extract<ContentBlock, { type: 'image' | 'file' }>> {
  validateDshArchiveAttachments(preview, manifest)
  const events = function* () { for (const log of preview.logs) yield* log.artifact.events }
  const refs = attachmentRefsInEvents(events())
  const resolved = new Map<string, Extract<ContentBlock, { type: 'image' | 'file' }>>()
  const visit = (blocks: readonly PortableContentBlockV1[]): void => {
    for (const block of blocks) {
      if (block.kind === 'tool-result') visit(block.content)
      if (block.kind !== 'attachment') continue
      const key = portableAttachmentKey(block)
      if (resolved.has(key)) continue
      if (imageMediaType(block.mediaType)) {
        const image = refs.images.get(block.attachmentId)
        if (image === undefined || image.mediaType !== block.mediaType) {
          throw new Error(`session import: missing logged image metadata for ${block.attachmentId}`)
        }
        const { name: _name, ...metadata } = image
        resolved.set(key, { type: 'image', attachment: structuredClone({ ...metadata,
          ...block.name === undefined ? {} : { name: block.name } }) })
      } else {
        const candidates = [...refs.files.values()].filter(ref => ref.attachmentId === block.attachmentId
          && (block.name === undefined || ref.name === block.name))
        const candidate = candidates[0]
        if (candidate === undefined || candidates.length !== 1 || block.mediaType !== 'application/octet-stream') {
          throw new Error(`session import: missing or ambiguous logged file metadata for ${block.attachmentId}`)
        }
        resolved.set(key, { type: 'file', attachment: structuredClone(candidate) })
      }
    }
  }
  for (const item of preview.bundle.context.items) visit(item.content)
  return resolved
}
