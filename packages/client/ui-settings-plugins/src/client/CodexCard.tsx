/** Toggle for the full Codex driver in Plugins → Plugin configuration. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import type { CodexCardFace } from './codex-card-controller.ts'
import { CODEX_NS } from './codex-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './fields.module.css'

/** Props bound by the configurable plugin slot. */
export type CodexCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<CodexCardFace>

/** Render the saved on/off setting for new Codex-backed sessions. */
export function CodexCard(props: CodexCardProps) {
  const { t } = props
  const state = props.useCodexCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="codexTitle"
      title={state.label.text.trim() || CODEX_NS}
      descriptionKey="codexDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.field}>
        <div className={css.head}>
          <label className={css.label} htmlFor="plugin-config-codex-label">{t('codexLabel')}</label>
        </div>
        <input
          id="plugin-config-codex-label"
          type="text"
          value={state.label.text}
          disabled={!state.writable || state.saving}
          onChange={(event) => { props.edit('label', event.target.value) }}
        />
        <p className={css.hint}>{t('codexLabelHint')}</p>
      </div>
      <div className={css.field}>
        <div className={css.head}>
          <label className={css.label} htmlFor="plugin-config-codex-enabled">{t('codexEnabled')}</label>
          {state.enabled.overridden
            ? <span className={css.badges}>
              <span className={css.badge}>{t('overridden')}</span>
              <button type="button" className={css.reset} disabled={!state.writable} onClick={() => { props.resetField('enabled') }}>
                {t('reset')}
              </button>
            </span>
            : null}
        </div>
        <input
          id="plugin-config-codex-enabled"
          type="checkbox"
          role="switch"
          checked={state.enabled.text === 'true'}
          disabled={!state.writable || state.saving}
          onChange={(event) => { props.edit('enabled', String(event.target.checked)) }}
        />
        <p className={css.hint}>{t('codexEnabledHint')}</p>
      </div>
    </PluginCard>
  )
}
