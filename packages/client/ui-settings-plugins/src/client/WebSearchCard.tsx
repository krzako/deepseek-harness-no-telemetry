/** Administrator-owned limits for model-facing web searches. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { WebSearchCardFace } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Web Search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the model-facing search limits.
 * @param props - locale copy, card snapshot, and form actions.
 * @returns the Web Search plugin card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  const common = {
    overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('positiveIntegerInvalid'), numeric: true, disabled,
  }
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        {...common}
        {...state.searchMaxResults}
        id="plugin-config-web-search-max-results"
        label={t('webSearchMaxResults')}
        hint={t('webSearchMaxResultsHint')}
        onEdit={(text) => { props.edit('searchMaxResults', text) }}
        onReset={() => { props.resetField('searchMaxResults') }}
      />
      <ValueField
        {...common}
        {...state.searchMaxQueries}
        id="plugin-config-web-search-max-queries"
        label={t('webSearchMaxQueries')}
        hint={t('webSearchMaxQueriesHint')}
        onEdit={(text) => { props.edit('searchMaxQueries', text) }}
        onReset={() => { props.resetField('searchMaxQueries') }}
      />
      <ValueField
        {...common}
        {...state.searchMaxConcurrent}
        id="plugin-config-web-search-max-concurrent"
        label={t('webSearchMaxConcurrent')}
        hint={t('webSearchMaxConcurrentHint')}
        onEdit={(text) => { props.edit('searchMaxConcurrent', text) }}
        onReset={() => { props.resetField('searchMaxConcurrent') }}
      />
      <ValueField
        {...common}
        {...state.searchTimeoutMs}
        id="plugin-config-web-search-timeout"
        label={t('webSearchTimeoutMs')}
        hint={t('webSearchTimeoutMsHint')}
        onEdit={(text) => { props.edit('searchTimeoutMs', text) }}
        onReset={() => { props.resetField('searchTimeoutMs') }}
      />
    </PluginCard>
  )
}
