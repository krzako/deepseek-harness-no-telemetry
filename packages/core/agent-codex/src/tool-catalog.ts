import { createHash } from 'node:crypto'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CodexDynamicTool } from './protocol.ts'

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Stable, detached model-facing catalog for one Codex turn. */
export interface CodexToolCatalog {
  readonly version: 1
  readonly hash: string
  readonly tools: readonly CodexDynamicTool[]
}

export function codexToolCatalog(schemas: readonly ToolSchema[]): CodexToolCatalog {
  const tools = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map((schema): CodexDynamicTool => {
      const parameters = snapshotJsonValue(schema.parameters)
      if (parameters === undefined) {
        throw new Error(`agent-codex: tool ${JSON.stringify(schema.name)} has invalid JSON parameters`)
      }
      return { type: 'function', name: schema.name, description: schema.description, inputSchema: parameters }
    })
  const snapshot = snapshotJsonValue(tools)
  if (snapshot === undefined) throw new Error('agent-codex: tool catalog is not lossless JSON')
  return {
    version: 1,
    hash: `sha256:${createHash('sha256').update(canonicalJson(snapshot as unknown as JsonValue)).digest('hex')}`,
    tools,
  }
}
