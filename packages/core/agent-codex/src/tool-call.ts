import { createHash } from 'node:crypto'
import { ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CodexJsonObject } from './protocol.ts'
import { codexToolCatalog, type CodexToolCatalog } from './tool-catalog.ts'

export interface BoundCodexToolCall {
  readonly codexCallId: string
  readonly dshCallId: ReturnType<typeof ToolCallId>
  readonly name: string
  readonly arguments: JsonValue
}

/** Validate a Codex call against both the advertised snapshot and the live agent scope. */
export function bindCodexToolCall(
  params: CodexJsonObject,
  sessionId: string,
  turnId: string,
  catalog: CodexToolCatalog,
  currentTool: ToolSchema | undefined,
): BoundCodexToolCall {
  const { callId, tool, namespace } = params
  if (typeof callId !== 'string' || callId.length === 0) throw new Error('agent-codex: tool call has no callId')
  if (typeof tool !== 'string' || tool.length === 0) throw new Error('agent-codex: tool call has no name')
  if (namespace !== null && namespace !== undefined) {
    throw new Error('agent-codex: namespaced dynamic tools were not advertised')
  }
  const offered = catalog.tools.find(candidate => candidate.name === tool)
  if (offered === undefined || currentTool === undefined) {
    throw new Error(`agent-codex: tool ${JSON.stringify(tool)} is not visible in the active DSH scope`)
  }
  const offeredHash = codexToolCatalog([{ name: offered.name, description: offered.description,
    parameters: offered.inputSchema }]).hash
  if (offeredHash !== codexToolCatalog([currentTool]).hash) {
    throw new Error(`agent-codex: tool ${JSON.stringify(tool)} changed since turn admission`)
  }
  if (params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
    throw new Error('agent-codex: tool arguments must be a JSON object')
  }
  const args = snapshotJsonValue(params.arguments)
  if (args === undefined) throw new Error('agent-codex: tool arguments are not lossless JSON')
  const violations = validateJsonSchemaValue(offered.inputSchema, args, 'arguments')
  if (violations.length > 0) throw new Error(`agent-codex: tool arguments violate schema: ${violations.join('; ')}`)
  const digest = createHash('sha256').update(JSON.stringify([sessionId, turnId, callId])).digest('hex')
  return { codexCallId: callId, dshCallId: ToolCallId(`codex_${digest}`), name: tool,
    arguments: args as JsonValue }
}
