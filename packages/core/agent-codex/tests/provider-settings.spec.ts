import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { CodexAgentProvider } from '../src/provider.ts'
import { CodexAgent } from '../src/agent.ts'
import { codexPrivateSnapshot, type CodexContextSnapshotV2 } from '../src/context-snapshot.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('Codex driver setting', () => {
  it('selects Codex only for new matching sessions, and keeps an existing Codex thread on disable', async () => {
    const ctx = new Context()
    const attachmentRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-ports-'))
    try {
      await ctx.plugin(MemorySettings)
      const settings = ctx.settings as MemorySettings
      const ordinaryProfile = { providers: { local: { baseURL: 'http://standard.invalid/v1', models: [{ id: 'test-model' }] } } }
      settings.doc['llm-pi-ai'] = structuredClone(ordinaryProfile)
      await ctx.plugin(SessionStore)
      await ctx.plugin(LocalAttachmentStore, { dshHome: attachmentRoot })
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(LocalSubprocessRuntime)
      const codexFiber = await ctx.plugin(CodexAgentProvider, {
        binaryPath: '/unused/codex',
        runtimeRevision: 'test-fork',
        env: { LOCAL_KEY: 'present-only-in-runtime' },
        label: 'Codex',
        providers: { local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:9999/v1', models: [{ id: 'test-model' }] } },
      })

      const transfer = ctx.agents.getTransferPorts('codex')
      expect(transfer.source.driverId).toBe('codex')
      expect(transfer.target.driverId).toBe('codex')
      const checkpoint = JSON.parse(readFileSync(new URL('./fixtures/context-snapshot-v2-rust.json', import.meta.url), 'utf8')) as CodexContextSnapshotV2
      const sourceModel = { provider: 'codex:local', id: 'local/test-model' }
      const create = vi.spyOn(ctx.agents, 'create').mockRejectedValueOnce(new Error('publication probe'))
      const signal = new AbortController().signal
      await expect(transfer.target.createImportedAgent({
        context: { version: 1, source: { version: 1, sessionId: 'import-source', driver: { id: 'codex', version: '1' },
          model: sourceModel }, items: [], effectiveItemIds: [], compactions: [] },
        privateSnapshot: codexPrivateSnapshot(checkpoint), targetSessionId: SessionId('import-target'), targetModel: sourceModel,
        lineage: { sourceSessionId: 'import-source', sourceDriverId: 'codex', importId: 'publication-test' },
      }, { cwd: '/selected-workspace', signal })).rejects.toThrow('publication probe')
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'import-target', route: { kind: 'import', driverId: 'codex' }, signal,
        meta: { cwd: '/selected-workspace', importLineage: {
          sourceSessionId: 'import-source', sourceDriverId: 'codex', importId: 'publication-test',
        } },
      }))
      create.mockRestore()
      await expect(transfer.target.describeAuthentication({ provider: 'codex:local', id: 'local/test-model' }))
        .resolves.toEqual({ status: 'configured', reference: 'LOCAL_KEY' })
      expect(await transfer.target.importCapabilities()).toMatchObject({
        availableModels: [{ provider: 'codex:local', id: 'local/test-model' }],
        supportedPrivateRevisions: ['test-fork'],
      })

      expect(ctx.agents.listDriverCatalogs()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex', models: [] }),
        expect.objectContaining({
          id: 'codex:local', name: 'Codex: local',
          models: [expect.objectContaining({ id: 'local/test-model', name: 'Codex: test-model' })],
        }),
      ]))
      expect(ctx.llm.listConfigurableProviders()).toContainEqual({
        provider: 'codex:local', displayName: 'Codex: local', settingsNs: 'codex',
        settingsPath: ['providers', 'local'], declared: true,
      })
      const catalogChanges = vi.fn()
      ctx.on('llm/adapters-updated', catalogChanges)
      const direct = ctx.agents.createDriver(ctx, SessionId('direct-codex'), {
        provider: 'codex:local', model: 'local/test-model',
      }, Session.create(SessionId('direct-codex')))
      expect(direct?.agent).toBeInstanceOf(CodexAgent)
      expect(direct?.agent.options).toMatchObject({ provider: 'codex', model: 'local/test-model' })
      expect(direct?.agent).toMatchObject({ threadOptions: { sandbox: 'danger-full-access' } })
      await direct?.dispose()

      const fresh = Session.create(SessionId('new-standard-session'))
      const options = { provider: 'local', model: 'test-model' }
      expect(ctx.agents.createDriver(ctx, fresh.id, options, fresh)).toBeUndefined()

      await ctx.settings.update('codex', { enabled: true })
      const chosen = ctx.agents.createDriver(ctx, fresh.id, options, fresh)
      expect(chosen?.driverId).toBe('codex')
      expect(chosen?.agent).toBeInstanceOf(CodexAgent)
      expect(chosen?.agent.options).toMatchObject({ provider: 'codex', model: 'local/test-model' })
      expect(chosen?.agent).toMatchObject({ threadOptions: { sandbox: 'danger-full-access' } })
      await chosen?.dispose()

      const previousStandard = Session.create(SessionId('previous-standard'))
      previousStandard.append('agent/driver-selected', { version: 1, driverId: 'standard' })
      expect(ctx.agents.createDriver(ctx, previousStandard.id, options, previousStandard)).toBeUndefined()
      previousStandard.append('turn/start', { turn: 1 })
      expect(ctx.agents.createDriver(ctx, previousStandard.id, options, previousStandard)).toBeUndefined()
      expect(ctx.agents.createDriver(ctx, fresh.id, { provider: 'other', model: 'test-model' }, fresh)).toBeUndefined()

      fresh.append('codex/thread-bound', {
        version: 1, threadId: 'thread-1' as never, runtimeVersion: 'test-fork', cwd: '/workspace',
      })
      fresh.append('agent/driver-selected', { version: 1, driverId: 'codex' })
      await ctx.settings.update('codex', { enabled: false })
      const legacy = Session.create(SessionId('legacy-no-selection'))
      expect(ctx.agents.createDriver(ctx, legacy.id, options, legacy, { kind: 'resume' })).toBeUndefined()
      const imported = Session.create(SessionId('import-target-codex'))
      const importedDriver = ctx.agents.createDriver(ctx, imported.id, options, imported, { kind: 'import', driverId: 'codex' })
      expect(importedDriver?.driverId).toBe('codex')
      await importedDriver?.dispose()
      expect(ctx.agents.createDriver(ctx, imported.id, options, imported, { kind: 'import', driverId: 'standard' })).toBeUndefined()
      const resumed = ctx.agents.createDriver(ctx, fresh.id, options, fresh)
      expect(resumed?.agent).toBeInstanceOf(CodexAgent)
      await resumed?.dispose()
      const beforeThreadBinding = Session.create(SessionId('selected-before-thread'))
      beforeThreadBinding.append('agent/driver-selected', { version: 1, driverId: 'codex' })
      const selectedAfterDisable = ctx.agents.createDriver(ctx, beforeThreadBinding.id, options, beforeThreadBinding)
      expect(selectedAfterDisable?.driverId).toBe('codex')
      await selectedAfterDisable?.dispose()
      expect(ctx.agents.createDriver(ctx, previousStandard.id, options, previousStandard)).toBeUndefined()

      await ctx.settings.update('codex', { label: 'Fork', providers: {
        local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:9999/v1', displayName: 'Local renamed', models: [{ id: 'test-model' }] },
        remote: { apiKeyEnv: 'REMOTE_KEY', baseURL: 'http://127.0.0.1:9998/v1', models: [{ id: 'remote-model' }] },
      } })
      await vi.waitFor(() => { expect(catalogChanges).toHaveBeenCalled() })
      expect(ctx.agents.listDriverCatalogs()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex:local', name: 'Fork: Local renamed', models: [expect.objectContaining({ name: 'Fork: test-model' })] }),
        expect.objectContaining({ id: 'codex:remote', name: 'Fork: remote' }),
      ]))
      expect(ctx.llm.listConfigurableProviders()).toEqual([
        { provider: 'codex:local', displayName: 'Fork: Local renamed', settingsNs: 'codex',
          settingsPath: ['providers', 'local'], declared: true },
        { provider: 'codex:remote', displayName: 'Fork: remote', settingsNs: 'codex',
          settingsPath: ['providers', 'remote'], declared: true },
      ])
      const beforeModelEdit = catalogChanges.mock.calls.length
      await ctx.settings.update('codex', { providers: {
        local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:9999/v1', displayName: 'Local renamed', models: [{ id: 'next-model' }] },
        remote: { apiKeyEnv: 'REMOTE_KEY', baseURL: 'http://127.0.0.1:9998/v1', models: [{ id: 'remote-model' }] },
      } })
      await vi.waitFor(() => { expect(catalogChanges.mock.calls.length).toBeGreaterThan(beforeModelEdit) })
      expect(ctx.agents.listDriverCatalogs()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex:local', models: [expect.objectContaining({ id: 'local/next-model' })] }),
      ]))
      expect((await transfer.target.importCapabilities()).availableModels).toEqual([
        { provider: 'codex:local', id: 'local/next-model' },
        { provider: 'codex:remote', id: 'remote/remote-model' },
      ])
      expect(settings.doc['llm-pi-ai']).toEqual(ordinaryProfile)
      expect(ctx.agents.createDriver(ctx, previousStandard.id, options, previousStandard)).toBeUndefined()
      const nextCodex = ctx.agents.createDriver(ctx, SessionId('next-codex'), {
        provider: 'codex:local', model: 'local/next-model',
      }, Session.create(SessionId('next-codex')))
      expect(nextCodex?.driverId).toBe('codex')
      await nextCodex?.dispose()
      await codexFiber.dispose()
      expect(() => ctx.agents.getTransferPorts('codex')).toThrow('unavailable')
      expect(ctx.llm.listConfigurableProviders()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      rmSync(attachmentRoot, { recursive: true, force: true })
    }
  })
})
