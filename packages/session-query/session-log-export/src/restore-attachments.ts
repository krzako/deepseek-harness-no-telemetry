/** Restore archived durable attachment references without replaying Session events. */

import { open, readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { DshArchiveBundlePreview } from './archive-bundle.ts'
import type { DshSessionArchiveManifestV1 } from './manifest.ts'
import { attachmentRefsInEvents, auditArtifactRefsInEvents, fileEntryPath, mediaEntryPath } from './archive.ts'
import { validateDshArchiveAttachments } from './archive-attachments.ts'
import { withDshArchiveAttachments, type DshZipValidationPolicy } from './zip-validation.ts'

/** Restore logged images, files and audit blobs before publishing an imported Session.
 * The caller supplies the validated bundle from this archive. All referenced receipts
 * and the entire ZIP are checked before writing to the destination store. Images are
 * restored byte-for-byte, one resident image at a time; generic files and audit blobs
 * stream in bounded chunks. Backend reference changes are errors, never remappings.
 * No historical events, tools or model calls run. A later failure may leave durable
 * content-addressed objects; they are shared and must not be deleted by rollback.
 * This is not the Session/workspace publication transaction or canonical projection.
 * @param path - stable private ZIP matching the validated bundle.
 * @param manifest - verified manifest for that bundle.
 * @param preview - decoded and validated logs and canonical context.
 * @param store - destination attachment provider.
 * @param stagingParent - authorized private staging parent directory.
 * @param policy - optional limits for the whole ZIP.
 * @param signal - cancellation between objects and during file reads.
 */
export async function restoreDshArchiveAttachments(
  path: string,
  manifest: DshSessionArchiveManifestV1,
  preview: DshArchiveBundlePreview,
  store: Pick<AttachmentStore, 'restoreImage' | 'saveFileStream'>,
  stagingParent: string,
  policy: DshZipValidationPolicy = {},
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const expected = structuredClone(manifest)
  validateDshArchiveAttachments(preview, expected)
  const events = function* () { for (const log of preview.logs) yield* log.artifact.events }
  const refs = structuredClone(attachmentRefsInEvents(events()))
  const files = new Map<string, FileAttachmentRef>()
  for (const ref of refs.files.values()) files.set(fileEntryPath(String(ref.attachmentId), ref.name), ref)
  for (const log of preview.logs) {
    for (const [sha256, ref] of auditArtifactRefsInEvents(log.artifact.events).refs) {
      const name = `audit/${sha256}.blob`
      const entry = expected.entries.find(entry => entry.path === name)
      if (entry?.kind !== 'attachment' || entry.bytes !== ref.bytes || entry.sha256 !== sha256) {
        throw new Error('session import: audit attachment receipt disagrees with manifest')
      }
      files.set(name, structuredClone(ref))
    }
  }
  await withDshArchiveAttachments(path, expected, stagingParent, async (staged) => {
    const requirePath = (name: string): string => {
      const file = staged.get(name)
      if (file === undefined) throw new Error(`session import: missing staged attachment ${name}`)
      return file
    }
    for (const ref of refs.images.values()) {
      signal?.throwIfAborted()
      const data = await readFile(requirePath(mediaEntryPath(String(ref.attachmentId), ref.mediaType)), { signal })
      const restored = await store.restoreImage({ ref: structuredClone(ref), data }, signal)
      if (!isDeepStrictEqual(restored, ref)) throw new Error('session import: image provider changed archived reference')
    }
    for (const [name, ref] of files) {
      signal?.throwIfAborted()
      const file = await open(requirePath(name), 'r')
      try {
        const chunks = async function* () {
          while (true) {
            signal?.throwIfAborted()
            const buffer = new Uint8Array(64 * 1024)
            const { bytesRead } = await file.read(buffer)
            signal?.throwIfAborted()
            if (bytesRead === 0) return
            yield buffer.subarray(0, bytesRead)
          }
        }
        const restored = await store.saveFileStream({ data: chunks(), name: ref.name, ...signal === undefined ? {} : { signal } })
        if (!isDeepStrictEqual(restored, ref)) throw new Error('session import: file provider changed archived reference')
      } finally { await file.close() }
    }
    signal?.throwIfAborted()
  }, policy, signal)
}
