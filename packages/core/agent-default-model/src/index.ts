/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** Stored and composed default model selection. */
export interface AgentDefaultModelSettings {
  /** Execution engine; absent selects the standard loop for existing settings. */
  agent?: 'standard' | 'codex'
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  agent: z.union(['standard', 'codex']),
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/** Composition entry for the default model selection. */
export interface Config {
  /** Execution engine for the composition default. */
  agent?: 'standard' | 'codex'
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: AgentDefaultModelSettings): ModelSelection {
  const codex = settings.agent === 'codex'
  return {
    provider: codex ? `codex:${settings.provider}` : settings.provider,
    model: codex
      ? `${encodeURIComponent(settings.provider)}/${encodeURIComponent(settings.model)}`
      : settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    agent: z.union(['standard', 'codex']),
    provider: z.string().required(),
    model: z.string().required(),
  })

  private source: () => AgentDefaultModelSettings

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentDefaultModel')
    const entry: AgentDefaultModelSettings = {
      ...(config.agent === undefined ? {} : { agent: config.agent }),
      provider: config.provider,
      model: config.model,
    }
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
        setSource: (current) => { this.source = current },
        // Every consumer reads through currentSelection(), so no registration-level fact
        // needs rebuilding when the settings document changes.
        onChange: () => {},
      })
    })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    return selection(this.source())
  }

  /**
   * Save the complete default model selection. A deployment without a settings
   * provider keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const codexProvider = next.provider.startsWith('codex:') ? next.provider.slice('codex:'.length) : undefined
    const encodedPrefix = codexProvider === undefined ? undefined : `${encodeURIComponent(codexProvider)}/`
    if (encodedPrefix !== undefined && !next.model.startsWith(encodedPrefix)) {
      throw new Error(`Codex model ${JSON.stringify(next.model)} does not belong to ${JSON.stringify(codexProvider)}`)
    }
    await this.ctx.get('settings')?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      agent: codexProvider === undefined ? 'standard' : 'codex',
      provider: codexProvider ?? next.provider,
      model: encodedPrefix === undefined ? next.model : decodeURIComponent(next.model.slice(encodedPrefix.length)),
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    })
  }
}

export default AgentDefaultModelConfig
