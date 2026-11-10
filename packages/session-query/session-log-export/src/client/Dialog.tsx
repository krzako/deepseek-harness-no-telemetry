import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionArchiveFormat, SessionLogDownloadState } from './controller.ts'
import { NS } from './locales.ts'
import css from './Dialog.module.css'

/** Browser operations and state injected into the Session Header contribution. */
export interface SessionLogDownloadDialogInjected {
  hooks: { sessionLogDownload: ObservableSnapshot<SessionLogDownloadState> }
  request: (sessionId: SessionId) => Promise<void>
  confirm: (sessionId: SessionId, format: SessionArchiveFormat, includeWorkspace?: boolean) => Promise<void>
  dismiss: (sessionId: SessionId) => void
}

export type SessionLogDownloadDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

/**
 * Modal shared by the Session Header button and this browser's `/export` command.
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionLogDownloadDialog({
  sessionId, useSessionLogDownload, confirm, dismiss, t,
}: SessionLogDownloadDialogProps) {
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])

  const status = entry?.status
  const open = entry?.open === true
  const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null
  const title = status === 'confirmation' ? t('dialog.confirmTitle') : status === 'downloading'
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'confirmation' ? t('dialog.plaintextWarning') : status === 'downloading'
    ? t('dialog.preparingDescription')
    : status === 'success' ? t('dialog.successDescription') : error ?? t('dialog.commandFailed')

  return (
    <Modal
      open={open}
      className={css.dialog ?? ''}
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={status === 'confirmation' ? <div className={css.actions}>
        <Button variant="primary" onClick={() => { void confirm(sessionId, 'portable') }}>{t('dialog.downloadPortable')}</Button>
        <Button onClick={() => { void confirm(sessionId, 'portable', true) }}>{t('dialog.downloadWorkspace')}</Button>
        <Button onClick={() => { void confirm(sessionId, 'log') }}>{t('dialog.downloadLog')}</Button>
        <Button onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>
      </div> : <Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>}
    />
  )
}
