// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CodexAuditLedger } from '../src/client/CodexAuditLedger.tsx'
import type { TrajectoryCodexAuditFact } from '../src/client/trajectory-contract.ts'
import { t, tZh } from './locale.client.ts'

afterEach(cleanup)

function fact(seq: number): TrajectoryCodexAuditFact {
  return {
    seq, time: seq,
    fact: {
      version: 1, sequence: seq, eventId: `event-${seq}`, time: seq,
      threadId: 'thread-1', turn: 2, codexTurnId: 'turn-2',
      kind: 'model/request', attemptId: `attempt-${seq}`, purpose: 'inference',
      stage: 'model-visible', apiFormat: 'responses',
      request: { kind: 'inline', value: { instructions: 'complete prompt' } },
    },
  }
}

describe('Codex audit ledger', () => {
  it('loads artifact content on demand and reports a verification failure without showing partial text', async () => {
    const sha256 = 'a'.repeat(64)
    const artifactFact = { ...fact(1), fact: {
      ...fact(1).fact,
      request: { kind: 'artifact', sha256, bytes: 17, mediaType: 'application/json' },
    } as TrajectoryCodexAuditFact['fact'] }
    const loadArtifact = vi.fn(async () => '{"prompt":"private"}')
    const { rerender } = render(<CodexAuditLedger facts={[artifactFact]} hasOlderRecords={false}
      loadOlder={vi.fn(async () => false)} loadArtifact={loadArtifact} t={t} />)
    expect(loadArtifact).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Load full audit content' }))
    await waitFor(() => { expect(screen.getByText('{"prompt":"private"}')).toBeTruthy() })
    expect(loadArtifact).toHaveBeenCalledWith('event-1', sha256)
    const failedFact = { ...artifactFact, seq: 2, fact: { ...artifactFact.fact, eventId: 'event-2' } }
    rerender(<CodexAuditLedger facts={[failedFact]} hasOlderRecords={false}
      loadOlder={vi.fn(async () => false)}
      loadArtifact={vi.fn(async () => { throw new Error('digest mismatch') })} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load full audit content' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('digest mismatch') })
    expect(screen.queryByText('{"prompt":"private"}')).toBeNull()
  })
  it('shows ordered operations and identifiers with details but no duplicate Chat reply', () => {
    const { container } = render(<CodexAuditLedger
      facts={[fact(4), { ...fact(5), fact: {
        ...fact(5).fact, kind: 'model/result', stage: 'codex',
        result: { kind: 'inline', value: { output: 'Final answer' } },
      } as TrajectoryCodexAuditFact['fact'] }]}
      hasOlderRecords={false}
      loadOlder={vi.fn(async () => false)}
      loadArtifact={vi.fn(async () => '')}
      t={t}
    />)
    expect(screen.getByRole('region', { name: 'Codex audit · 2' })).toBeTruthy()
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('li')?.textContent).toContain('model/request')
    expect(container.querySelector('li')?.textContent).toContain('attempt-4')
    expect(container.querySelectorAll('details:not([open])')).toHaveLength(2)
    expect(container.querySelector('pre')?.textContent).toContain('complete prompt')
  })

  it('reveals resident older events before requesting another Session page', async () => {
    const loadOlder = vi.fn(async () => true)
    const { rerender } = render(<CodexAuditLedger
      facts={Array.from({ length: 55 }, (_, index) => fact(index + 1))}
      hasOlderRecords={true}
      loadOlder={loadOlder}
      loadArtifact={vi.fn(async () => '')}
      t={tZh}
    />)
    expect(screen.getByRole('region', { name: 'Codex 审计 · 55' })).toBeTruthy()
    expect(screen.queryByText('event-1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '加载更早的 Codex 事件' }))
    expect(screen.getByText('event-1')).toBeTruthy()
    expect(loadOlder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '加载更早的 Codex 事件' }))
    await waitFor(() => { expect(loadOlder).toHaveBeenCalledOnce() })
    rerender(<CodexAuditLedger facts={Array.from({ length: 56 }, (_, index) => fact(index + 1))}
      hasOlderRecords={false} loadOlder={loadOlder} loadArtifact={vi.fn(async () => '')} t={tZh} />)
    expect(screen.getByText('event-1')).toBeTruthy()
  })
})
