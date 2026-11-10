import { useState } from 'react'
import type { TrajectoryCodexAuditFact } from './trajectory-contract.ts'
import type { TrajectoryTranslate } from './locales.ts'
import css from './CodexAuditLedger.module.css'

const PAGE_SIZE = 50

interface CodexAuditLedgerProps {
  readonly facts: readonly TrajectoryCodexAuditFact[]
  readonly hasOlderRecords: boolean
  readonly loadOlder: () => Promise<boolean>
  readonly loadArtifact: (eventId: string, sha256: string) => Promise<string>
  readonly t: TrajectoryTranslate
}

/** Render recorded Codex operations without turning model results into Chat replies. */
export function CodexAuditLedger({ facts, hasOlderRecords, loadOlder, loadArtifact, t }: CodexAuditLedgerProps) {
  const [limit, setLimit] = useState(PAGE_SIZE)
  if (facts.length === 0) return null
  const visible = facts.slice(-limit)
  const revealEarlier = async () => {
    if (facts.length > limit || await loadOlder()) setLimit(current => current + PAGE_SIZE)
  }
  return (
    <section className={css.root} aria-label={t('audit.heading', { count: facts.length })}>
      <div className={css.heading}>{t('audit.heading', { count: facts.length })}</div>
      {(facts.length > limit || hasOlderRecords) && (
        <button className={css.load} type="button" onClick={() => { void revealEarlier() }}>
          {t('audit.loadEarlier')}
        </button>
      )}
      <ol className={css.list}>
        {visible.map(({ seq, fact }) => (
          <li className={css.item} key={seq}>
            <details>
              <summary className={css.summary}>
                #{seq} · {fact.kind} · {t('audit.turn', { turn: fact.turn })} · <code>{fact.eventId}</code>
                {'attemptId' in fact && <> · <code>{fact.attemptId}</code></>}
                {'codexCallId' in fact && <> · <code>{fact.codexCallId}</code></>}
                {'compactionId' in fact && <> · <code>{fact.compactionId}</code></>}
              </summary>
              <pre className={css.payload}>{JSON.stringify(fact, null, 2)}</pre>
              {Object.entries(fact as Record<string, unknown>).filter(([, value]) => isArtifact(value)).map(([field, value]) => (
                <AuditArtifact key={field} field={field} eventId={fact.eventId} sha256={(value as { sha256: string }).sha256}
                  load={loadArtifact} t={t} />
              ))}
            </details>
          </li>
        ))}
      </ol>
    </section>
  )
}

function isArtifact(value: unknown): value is { kind: 'artifact'; sha256: string } {
  return value !== null && typeof value === 'object' && 'kind' in value
    && value.kind === 'artifact' && 'sha256' in value && typeof value.sha256 === 'string'
}

function AuditArtifact({ field, eventId, sha256, load, t }: {
  field: string
  eventId: string
  sha256: string
  load: (eventId: string, sha256: string) => Promise<string>
  t: TrajectoryTranslate
}) {
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; text?: string; error?: string }>(
    { status: 'idle' },
  )
  const reveal = async () => {
    setState({ status: 'loading' })
    try {
      const text = await load(eventId, sha256)
      setState({ status: 'ready', text })
    } catch (error) {
      setState({ status: 'error', error: String(error) })
    }
  }
  return <div className={css.artifact}>
    <code>{field}</code>{' '}
    <button type="button" disabled={state.status === 'loading'} onClick={() => { void reveal() }}>
      {state.status === 'loading' ? t('audit.artifactLoading') : t('audit.artifactLoad')}
    </button>
    {state.status === 'error' && <p role="alert">{t('audit.artifactError', { reason: state.error ?? '' })}</p>}
    {state.status === 'ready' && <pre className={css.payload}>{state.text}</pre>}
  </div>
}
