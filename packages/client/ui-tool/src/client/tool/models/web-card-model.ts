/** Pure web-card derivation from raw web result metadata. @module */
import type { WebBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall } from './raw-tool-call.ts'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** Web-card data owned by the presenter; render sites add localized labels and classes. */
export type WebCardModelProps = DistributiveOmit<WebBlockProps, 'labels' | 'className'>

function validWebCall(block: ToolCallBlock): 'web_fetch' | null {
  const call = parsedToolCall(block)
  if (call === null) return null
  if (call.name === 'web_fetch') {
    const { url } = call.args
    return typeof url === 'string' && url.trim() !== '' ? call.name : null
  }
  return null
}

/**
 * Derive a settled root web-fetch card from persisted metadata.
 * @param block - running or settled Tool block.
 * @returns web-card props, or null for the generic path.
 */
export function webCardModel(block: ToolCallBlock): WebCardModelProps | null {
  if (block.parentCallId !== undefined || !('kind' in block) || block.isError) return null
  const tool = validWebCall(block)
  if (tool === null || typeof block.meta !== 'object' || block.meta === null || Array.isArray(block.meta)) return null
  const meta = block.meta as Record<string, unknown>
  if (typeof meta.truncated !== 'boolean') return null
  if (typeof meta.url !== 'string') return null
  if (typeof meta.statusCode !== 'number' || !Number.isInteger(meta.statusCode)) return null
  return {
    kind: 'fetch',
    url: meta.url,
    statusCode: meta.statusCode,
    truncated: meta.truncated,
  }
}
