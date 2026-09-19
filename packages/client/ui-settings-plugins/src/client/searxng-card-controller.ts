/** The SearXNG card's staged form over the `web-search-searxng` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, textField, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell,
} from './card-form.ts'

/** Namespace registered by the Host SearXNG provider. */
export const SEARXNG_NS = 'web-search-searxng'

/** Every user-configurable option supported by the SearXNG provider. */
export interface SearxngSettings {
  /** SearXNG instance root, including an optional path prefix. */
  baseURL?: string
  /** Language code forwarded to SearXNG. */
  language?: string
  /** Comma-separated search categories forwarded to SearXNG. */
  categories?: string
  /** SearXNG safe-search level from 0 through 2. */
  safesearch?: number
}

/** Match the Host provider's accepted instance-root syntax before saving. */
const baseURLField: CardFieldSpec = {
  field: 'baseURL',
  format: value => typeof value === 'string' ? value : '',
  parse: (text) => {
    const trimmed = text.trim()
    if (trimmed === '') return { kind: 'clear' }
    let url: URL
    try { url = new URL(trimmed) } catch { return undefined }
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
      ? { kind: 'set', value: trimmed }
      : undefined
  },
}

/** Safe-search accepts only the three levels defined by SearXNG. */
const safesearchField: CardFieldSpec = {
  field: 'safesearch',
  format: value => typeof value === 'number' ? String(value) : '',
  parse: (text) => {
    const trimmed = text.trim()
    if (trimmed === '') return { kind: 'clear' }
    const value = Number(trimmed)
    return Number.isInteger(value) && value >= 0 && value <= 2
      ? { kind: 'set', value }
      : undefined
  },
}

/** What the SearXNG card renders. */
export interface SearxngCardState extends CardShell {
  /** Instance root. */
  baseURL: CardFieldState
  /** Search language. */
  language: CardFieldState
  /** Search categories. */
  categories: CardFieldState
  /** Safe-search level. */
  safesearch: CardFieldState
}

/** The registration-side face the SearXNG card injects. */
export interface SearxngCardFace extends CardActions {
  /** Run a Host-side search through the current form values without saving them. */
  testConnection: (settings: SearxngSettings, signal?: AbortSignal) => Promise<boolean>
  hooks: {
    /** Card snapshot bound by the renderer as useSearxngCard. */
    searxngCard: SnapshotStore<SearxngCardState>
  }
}

/** Bridges the SearXNG settings scope onto the staged card form. */
export class SearxngCardController {
  private readonly form: CardForm<SearxngSettings>
  private readonly store: SnapshotStore<SearxngCardState>

  /** @param scope - bound settings scope for the SearXNG provider. */
  constructor(
    scope: SettingsScope<SearxngSettings>,
    private readonly testDraftConnection: (
      settings: SearxngSettings,
      signal?: AbortSignal,
    ) => Promise<boolean> = () => Promise.resolve(false),
  ) {
    this.form = new CardForm(scope, [
      baseURLField, textField('language'), textField('categories'), safesearchField,
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SearxngCardState {
    return {
      ...this.form.shell(),
      baseURL: this.form.field('baseURL'),
      language: this.form.field('language'),
      categories: this.form.field('categories'),
      safesearch: this.form.field('safesearch'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card snapshot and form actions.
   */
  inject(): SearxngCardFace {
    return {
      hooks: { searxngCard: this.store },
      ...this.form.actions(),
      testConnection: (settings, signal) => this.testDraftConnection(settings, signal),
    }
  }
}
