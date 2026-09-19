/** User-editable settings for the SearXNG search provider. */

import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { SearxngCardFace, SearxngSettings } from './searxng-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './SearxngCard.module.css'

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'failure'

/** Props the renderer binds for the SearXNG card. */
export type SearxngCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SearxngCardFace>

/**
 * Render every option supported by the SearXNG provider.
 * @param props - locale copy, card snapshot, and form actions.
 * @returns the SearXNG plugin card.
 */
export function SearxngCard(props: SearxngCardProps) {
  const { t } = props
  const state = props.useSearxngCard(snapshot => snapshot)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle')
  const activeTest = useRef<AbortController>()
  useEffect(() => () => { activeTest.current?.abort() }, [])
  const disabled = !state.writable
  const common = {
    overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled,
  }
  const testConnection = async () => {
    activeTest.current?.abort()
    const controller = new AbortController()
    activeTest.current = controller
    setConnectionStatus('testing')
    try {
      const draft: SearxngSettings = {}
      const baseURL = state.baseURL.text.trim()
      const language = state.language.text.trim()
      const categories = state.categories.text.trim()
      const safesearch = state.safesearch.text.trim()
      if (baseURL !== '') draft.baseURL = baseURL
      if (language !== '') draft.language = language
      if (categories !== '') draft.categories = categories
      if (safesearch !== '') draft.safesearch = Number(safesearch)
      const connected = await props.testConnection(draft, controller.signal)
      if (activeTest.current === controller) setConnectionStatus(connected ? 'success' : 'failure')
    } catch {
      if (activeTest.current === controller && !controller.signal.aborted) setConnectionStatus('failure')
    }
  }
  const edit = (field: string, text: string) => {
    setConnectionStatus('idle')
    props.edit(field, text)
  }
  const resetField = (field: string) => {
    setConnectionStatus('idle')
    props.resetField(field)
  }
  return (
    <PluginCard
      t={t}
      titleKey="searxngTitle"
      descriptionKey="searxngDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        {...common}
        {...state.baseURL}
        id="plugin-config-searxng-base-url"
        label={t('searxngBaseURL')}
        hint={t('searxngBaseURLHint')}
        invalidLabel={t('searxngBaseURLInvalid')}
        placeholder={t('searxngBaseURLPlaceholder')}
        onEdit={(text) => { edit('baseURL', text) }}
        onReset={() => { resetField('baseURL') }}
      />
      <ValueField
        {...common}
        {...state.language}
        id="plugin-config-searxng-language"
        label={t('searxngLanguage')}
        hint={t('searxngLanguageHint')}
        invalidLabel={t('searxngTextInvalid')}
        placeholder={t('searxngLanguagePlaceholder')}
        onEdit={(text) => { edit('language', text) }}
        onReset={() => { resetField('language') }}
      />
      <ValueField
        {...common}
        {...state.categories}
        id="plugin-config-searxng-categories"
        label={t('searxngCategories')}
        hint={t('searxngCategoriesHint')}
        invalidLabel={t('searxngTextInvalid')}
        placeholder={t('searxngCategoriesPlaceholder')}
        onEdit={(text) => { edit('categories', text) }}
        onReset={() => { resetField('categories') }}
      />
      <ValueField
        {...common}
        {...state.safesearch}
        id="plugin-config-searxng-safesearch"
        label={t('searxngSafesearch')}
        hint={t('searxngSafesearchHint')}
        invalidLabel={t('searxngSafesearchInvalid')}
        numeric
        placeholder="0"
        onEdit={(text) => { edit('safesearch', text) }}
        onReset={() => { resetField('safesearch') }}
      />
      <div className={css.connectionTest}>
        <div className={css.connectionCopy} aria-live="polite">
          {connectionStatus === 'success'
            ? t('searxngConnectionSucceeded')
            : connectionStatus === 'failure'
              ? t('searxngConnectionFailed')
              : null}
        </div>
        <button
          type="button"
          className={css.testButton}
          disabled={state.invalid || state.saving || connectionStatus === 'testing'}
          onClick={() => { void testConnection() }}
        >
          {t(connectionStatus === 'testing' ? 'searxngTestingConnection' : 'searxngTestConnection')}
        </button>
      </div>
    </PluginCard>
  )
}
