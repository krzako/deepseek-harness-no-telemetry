/** Staged Codex driver switch over the `codex` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { booleanField, textField, CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/** Host settings namespace registered by the full Codex agent provider. */
export const CODEX_NS = 'codex'

/** The setting this card edits; provider definitions remain in settings.yaml. */
export interface CodexSettings {
  enabled: boolean
  label?: string
}

/** Card snapshot shown by the Codex switch. */
export interface CodexCardState extends CardShell {
  enabled: CardFieldState
  label: CardFieldState
}

/** Registration face for the Codex card. */
export interface CodexCardFace extends CardActions {
  hooks: { codexCard: SnapshotStore<CodexCardState> }
}

/** Stages and saves whether ordinary model routes use the Codex driver. */
export class CodexCardController {
  private readonly form: CardForm<CodexSettings>
  private readonly store: SnapshotStore<CodexCardState>

  constructor(scope: SettingsScope<CodexSettings>) {
    this.form = new CardForm(scope, [booleanField('enabled'), textField('label')])
    this.store = this.form.bind(() => ({
      ...this.form.shell(), enabled: this.form.field('enabled'), label: this.form.field('label'),
    }))
  }

  /** Return the snapshot and staged form actions for this card. */
  inject(): CodexCardFace {
    return { hooks: { codexCard: this.store }, ...this.form.actions() }
  }
}
