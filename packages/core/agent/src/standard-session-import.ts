/** Map portable effective context to standard-driver inputs without executing it. */

import {
  freezeMessage, MessageId, ToolCallId,
  type ContentBlock, type Message,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  isPortableAgentContextV1, portableAttachmentKey,
  type PortableAgentContextV1,
  type PortableContentBlockV1,
} from './portable-session.ts'

type AttachmentBlock = Extract<ContentBlock, { type: 'image' | 'file' }>

/** One ordered input retained from the source agent's effective context. */
export type StandardImportEntry =
  | { readonly kind: 'instruction'; readonly sourceItemId: string; readonly role: 'system' | 'developer'; readonly content: readonly ContentBlock[] }
  | { readonly kind: 'message'; readonly sourceItemId: string; readonly message: Message }

/** Resolved content for a later standard-driver Session creation. */
export interface StandardImportProjection {
  readonly entries: readonly StandardImportEntry[]
}

function contentBlocks(
  portable: readonly PortableContentBlockV1[],
  attachments: ReadonlyMap<string, AttachmentBlock>,
): ContentBlock[] {
  return portable.map<ContentBlock>((block) => {
    switch (block.kind) {
      case 'text':
      case 'reasoning':
        return { type: block.kind, text: block.text }
      case 'attachment': {
        const resolved = attachments.get(portableAttachmentKey(block))
        if (resolved === undefined || resolved.attachment.attachmentId !== block.attachmentId
          || (resolved.type === 'image' ? resolved.attachment.mediaType : 'application/octet-stream') !== block.mediaType
          || (block.name !== undefined && resolved.attachment.name !== block.name)) {
          throw new Error(`portable attachment ${block.attachmentId} is missing or inconsistent`)
        }
        return resolved
      }
      case 'tool-call':
        return { type: 'tool-call', id: ToolCallId(block.callId), name: block.name, arguments: block.arguments }
      case 'tool-result':
        return {
          type: 'tool-result', toolCallId: ToolCallId(block.callId),
          content: contentBlocks(block.content, attachments), isError: block.isError,
        }
      case 'refusal':
      case 'opaque':
        throw new Error(`standard driver cannot import portable ${block.kind} content`)
      default:
        throw new Error('standard driver cannot import an unknown portable content block')
    }
  })
}

/**
 * Prepare ordered, model-visible standard inputs from a validated DSH context.
 * Instructions remain separate because the target driver must decide how to
 * assemble its own next request. This function creates no Session and never
 * replays historical model or tool calls.
 * @param context - untrusted canonical context to validate and project.
 * @param targetSessionId - fresh Session id used for stable imported message ids.
 * @param targetModel - selected destination route, not source attribution.
 * @param attachments - complete image/file references keyed by portableAttachmentKey.
 * @returns effective entries in their original model-visible order.
 */
export function projectStandardImport(
  context: PortableAgentContextV1,
  targetSessionId: SessionId,
  targetModel: { readonly provider: string; readonly id: string },
  attachments: ReadonlyMap<string, AttachmentBlock>,
): StandardImportProjection {
  if (!isPortableAgentContextV1(context)) throw new TypeError('invalid portable context')
  if (targetSessionId.length === 0 || targetModel.provider.length === 0 || targetModel.id.length === 0) {
    throw new Error('standard import requires a target Session and model route')
  }
  const byId = new Map(context.items.map(item => [item.id, item] as const))
  const entries: StandardImportEntry[] = context.effectiveItemIds.map((id) => {
    const item = byId.get(id)
    if (item === undefined) throw new Error(`portable item ${id} is missing`)
    const content = contentBlocks(item.content, attachments)
    if (item.role === 'system' || item.role === 'developer') {
      if (content.some(block => block.type === 'tool-call' || block.type === 'tool-result')) {
        throw new Error(`portable instruction item ${id} contains a tool block`)
      }
      return { kind: 'instruction', sourceItemId: id, role: item.role, content }
    }
    const messageId = MessageId(`${targetSessionId}:import:${id}`)
    if (item.role === 'tool') {
      const [result] = content
      if (content.length !== 1 || result?.type !== 'tool-result') {
        throw new Error(`portable tool item ${id} must contain exactly one tool result`)
      }
      return {
        kind: 'message', sourceItemId: id,
        message: freezeMessage({ id: messageId, role: 'user' as const,
          source: { kind: 'tool' as const, callId: result.toolCallId }, content: [result] }),
      }
    }
    if (content.some(block => block.type === 'tool-result')
      || (item.role === 'user' && content.some(block => block.type === 'tool-call'))) {
      throw new Error(`portable ${item.role} item ${id} contains a tool block in the wrong role`)
    }
    return {
      kind: 'message', sourceItemId: id,
      message: freezeMessage({ id: messageId, role: item.role,
        source: item.role === 'assistant'
          ? { kind: 'model' as const, provider: targetModel.provider, model: targetModel.id }
          : { kind: 'user' as const },
        content }),
    }
  })
  return deepFreeze(structuredClone({ entries }))
}
