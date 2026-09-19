/** The Web Search card's staged form over the `web-search` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell } from './card-form.ts'

/** Namespace registered by the Host web service. */
export const WEB_SEARCH_NS = 'web-search'

/** A positive whole-number setting; blank inherits the deployment value. */
function positiveIntegerField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isSafeInteger(parsed) && parsed > 0 ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** Administrator-owned search behavior exposed by the card. */
export interface WebSearchSettings {
  /** Combined source cap for one search tool call. */
  searchMaxResults?: number
  /** Query-count cap for one search tool call. */
  searchMaxQueries?: number
  /** Provider searches allowed to execute concurrently across the Host. */
  searchMaxConcurrent?: number
  /** Cooperative search timeout in milliseconds. */
  searchTimeoutMs?: number
}

/** What the Web Search card renders. */
export interface WebSearchCardState extends CardShell {
  /** Combined source cap. */
  searchMaxResults: CardFieldState
  /** Query-count cap. */
  searchMaxQueries: CardFieldState
  /** Host-wide provider concurrency. */
  searchMaxConcurrent: CardFieldState
  /** Cooperative timeout. */
  searchTimeoutMs: CardFieldState
}

/** The registration-side face the Web Search card injects. */
export interface WebSearchCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebSearchCard. */
    webSearchCard: SnapshotStore<WebSearchCardState>
  }
}

/** Bridges the `web-search` settings scope onto the staged card form. */
export class WebSearchCardController {
  private readonly form: CardForm<WebSearchSettings>
  private readonly store: SnapshotStore<WebSearchCardState>

  /** @param scope - bound settings scope for Host web-search behavior. */
  constructor(scope: SettingsScope<WebSearchSettings>) {
    this.form = new CardForm(scope, [
      positiveIntegerField('searchMaxResults'),
      positiveIntegerField('searchMaxQueries'),
      positiveIntegerField('searchMaxConcurrent'),
      positiveIntegerField('searchTimeoutMs'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): WebSearchCardState {
    return {
      ...this.form.shell(),
      searchMaxResults: this.form.field('searchMaxResults'),
      searchMaxQueries: this.form.field('searchMaxQueries'),
      searchMaxConcurrent: this.form.field('searchMaxConcurrent'),
      searchTimeoutMs: this.form.field('searchTimeoutMs'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card snapshot and form actions.
   */
  inject(): WebSearchCardFace {
    return { hooks: { webSearchCard: this.store }, ...this.form.actions() }
  }
}
