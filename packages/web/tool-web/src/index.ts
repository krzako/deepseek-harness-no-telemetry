/**
 * Model-facing `web_fetch` tool over `ctx.web`. This package owns schemas,
 * validation, prompt guidance, limits, and presentation, never concrete providers. Enablement
 * controls tool registration; an enabled tool remains visible when its provider is unavailable
 * and fails with a structured error at execution time.
 * @module @deepseek-ai/dsh-tool-web
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { applyWebFetchTool } from './fetch.ts'

export { applyWebFetchTool, formatFetchOutput, parseFetchArgs, presentFetchCall, presentFetchResult, fetchMetaFromValue, fetchMetaFromResult } from './fetch.ts'
export type { WebFetchMeta } from './fetch.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-web'

/** Services required by the web tool suite. */
export const inject = ['tools', 'web', 'systemPrompt']

/** Default cooperative tool-call timeout budget (ms) for the web tools. */
export const DEFAULT_WEB_TOOL_TIMEOUT_MS = 30_000

/**
 * Default cap on one `web_fetch` output and on source characters converted
 * synchronously. This leaves headroom above the local provider's default
 * 100,000-character body cap while bounding custom providers and rendered output.
 */
export const DEFAULT_FETCH_MAX_OUTPUT_CHARS = 200_000

/** Plugin config for the fetch timeout and output cap. */
export interface Config {
  /** Cooperative timeout budget (ms) for `web_fetch`. Defaults to 30000. */
  fetchTimeoutMs?: number
  /** Cap on source characters converted and complete `web_fetch` output characters. Defaults to 200000. */
  fetchMaxOutputChars?: number
}

export const Config: z<Config> = z.object({
  fetchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
  fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured count, timeout, and character caps must be positive integers. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-web: ${name} must be a positive integer`)
  }
}

/**
 * Register the fetch tool. Its cooperative timeout budget (`fetchTimeoutMs`, default 30000) is resolved
 * here and attached to the tool as `ToolDefinition.timeoutMs` for
 * `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce. The tools' disposers are
 * fiber-scoped (the effect-based registries clean up on dispose), so no manual
 * teardown is needed.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('fetchTimeoutMs', resolved.fetchTimeoutMs)
  assertPositiveInteger('fetchMaxOutputChars', resolved.fetchMaxOutputChars)
  applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars)
}
