import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { CodexAgentProvider } from '../src/provider.ts'
import { CodexAgent } from '../src/agent.ts'

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
    try {
      await ctx.plugin(MemorySettings)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(CodexAgentProvider, {
        binaryPath: '/unused/codex',
        runtimeRevision: 'test-fork',
        label: 'Codex',
        providers: { local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:9999/v1', models: [{ id: 'test-model' }] } },
      })

      expect(ctx.agents.listDriverCatalogs()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex', models: [] }),
        expect.objectContaining({
          id: 'codex:local', name: 'Codex: local',
          models: [expect.objectContaining({ id: 'local/test-model', name: 'Codex: test-model' })],
        }),
      ]))
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
      expect(chosen?.agent).toBeInstanceOf(CodexAgent)
      expect(chosen?.agent.options).toMatchObject({ provider: 'codex', model: 'local/test-model' })
      expect(chosen?.agent).toMatchObject({ threadOptions: { sandbox: 'danger-full-access' } })
      await chosen?.dispose()

      const previousStandard = Session.create(SessionId('previous-standard'))
      previousStandard.append('turn/start', { turn: 1 })
      expect(ctx.agents.createDriver(ctx, previousStandard.id, options, previousStandard)).toBeUndefined()
      expect(ctx.agents.createDriver(ctx, fresh.id, { provider: 'other', model: 'test-model' }, fresh)).toBeUndefined()

      fresh.append('codex/thread-bound', {
        version: 1, threadId: 'thread-1' as never, runtimeVersion: 'test-fork', cwd: '/workspace',
      })
      await ctx.settings.update('codex', { enabled: false })
      const resumed = ctx.agents.createDriver(ctx, fresh.id, options, fresh)
      expect(resumed?.agent).toBeInstanceOf(CodexAgent)
      await resumed?.dispose()
      expect(ctx.agents.createDriver(ctx, previousStandard.id, options, previousStandard)).toBeUndefined()

      await ctx.settings.update('codex', { label: 'Fork', providers: {
        local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:9999/v1', displayName: 'Local renamed', models: [{ id: 'test-model' }] },
        remote: { apiKeyEnv: 'REMOTE_KEY', baseURL: 'http://127.0.0.1:9998/v1', models: [{ id: 'remote-model' }] },
      } })
      expect(ctx.agents.listDriverCatalogs()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex:local', name: 'Fork: Local renamed', models: [expect.objectContaining({ name: 'Fork: test-model' })] }),
        expect.objectContaining({ id: 'codex:remote', name: 'Fork: remote' }),
      ]))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
