// Web e2e scenarios: navigation & panes — the Trajectory view and timing
// overview, its local details inspector, and sidebar search, all over ONE rich
// two-turn seeded fixture rendered purely from the log (the seeded-history
// pattern: zero model calls in replay, so every surface here is the client
// fold + host history RPC, not replay binding). The seed is recorded live
// under the standard discipline: turn 1 produces a bash call plus two
// parallel reads in one assistant message (tool-call density for the
// trajectory ledger/timing lanes), turn 2 a markdown-rich reply.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { inspectDshWorkspaceImport, retainDshWorkspaceImport, prepareDshSessionArchiveImport, validateDshSessionZip, withDshWorkspaceSnapshot, type DshSessionArchiveManifestV1 } from '@deepseek-ai/dsh-session-log-export'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page, Response } from 'playwright'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { prepareAgentTransfer, type AgentDriverStateV1 } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, launchWebBrowser, newEnglishPage, saveFailureShot } from './support.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/navigation-panes', import.meta.url))
const SEED = join(SNAPSHOT_DIR, 'session.v2.jsonl')
const TRAJECTORY_EXPECTED = join(SNAPSHOT_DIR, 'trajectory.expected.md')
const SEARCH_EXPECTED = join(SNAPSHOT_DIR, 'search-results.expected.md')
const TERMINAL_EXPECTED = join(SNAPSHOT_DIR, 'terminal-card.expected.md')
const EXPORT_CONFIRMATION_EXPECTED = fileURLToPath(new URL('./expected/session-export-confirmation.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'navigation-panes-web-e2e'
let seedSearchTitle: string | undefined
const EXPORTED_LOG_FILE = `session.v${SESSION_FORMAT_VERSION}.jsonl`

// Turn 1 leads with a distinctive word: the session-title fallback takes the
// first words of the first message, so the sidebar-search scenario has a
// known-matching query ('navscenario') without depending on a live title call.
const PROMPT_TURN1 = 'NavScenario: first run bash to print exactly NAVIGATION_OK, then read nav-a.md and nav-b.md using two read calls in ONE assistant message, then reply with the single word FIRST_DONE and stop.'
const PROMPT_TURN2 = 'Reply in markdown with: a level-2 heading "Navigation Summary", a bulleted list of exactly two items, and a fenced code block containing echo WATERFALL. Then stop.'

async function baselineResponse(
  page: Page,
): Promise<Response> {
  return page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/session/list'
  ), { timeout: 30_000 })
}

async function assertBaselineSucceeded(response: Response, method: string): Promise<void> {
  expect(response.ok(), `${method} baseline HTTP response`).toBe(true)
  const body = await response.json() as { result?: { ok?: unknown } }
  expect(body.result?.ok, `${method} baseline RPC result`).toBe(true)
}

async function ensureSeedOpen(page: Page): Promise<void> {
  const welcome = page.locator('[class*="onboardingOverlay"]')
  if (await welcome.count() > 0) {
    await welcome.getByRole('button').click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
  }
  const chat = page.getByRole('tab', { name: 'Chat', exact: true })
  // Search is a collapsed header action; expand it so the input is actionable.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByPlaceholder('Search sessions', { exact: false })
  if (await chat.count() === 0) {
    await search.fill('WATERFALL')
    const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    const result = seedSearchTitle === undefined ? results : results.filter({ hasText: seedSearchTitle })
    await expect.poll(() => result.count(), { timeout: 15_000 }).toBe(1)
    await result.click()
    await chat.waitFor({ timeout: 15_000 })
  }
  await chat.click()
  await page.getByText('FIRST_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  if (await search.inputValue() !== '') {
    await search.fill('')
    await expect.poll(() => search.inputValue(), { timeout: 5_000 }).toBe('')
  }
}

describe('web e2e: navigation & panes over a rich seeded session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole> = { warnings: [], pageErrors: [] }
  let slotErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // The workspace-aware flow runs sessions in <workspaceCwd>/workspace;
    // the read targets must live in that session cwd (pre-creation is safe
    // because the picker adopts an existing directory by path).
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'nav-a.md'), '# alpha nav\n')
    await writeFile(join(sessionCwd, 'nav-b.md'), '# beta nav\n')
    if (MODE !== 'record') {
      const raw = await readFile(SEED, 'utf8')
      expect(fixtureUserPrompts(raw), 'seed fixture must carry exactly the two drive prompts')
        .toEqual([PROMPT_TURN1, PROMPT_TURN2])
      // Keep the recorded project separate from the scaffold home and its package symlinks.
      await seedSession({ ...scaffold, workspaceCwd: sessionCwd }, raw, SEED_ID)
    }
    browser = await launchWebBrowser()
  }, 120_000)

  beforeEach(async () => {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    slotErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        slotErrors.push(message.text())
      }
    })
    // Arm before navigation so the Session response cannot be missed. The
    // Workspace stream settles through the user-visible Ungrouped barrier.
    const sessionBaseline = baselineResponse(page)
    const [, sessionResponse] = await Promise.all([
      page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }),
      sessionBaseline,
    ])
    await assertBaselineSucceeded(sessionResponse, 'session.list')
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The frame mounts before the asynchronous session-list baseline lands.
    // Search must target the settled seeded row, not the startup input that
    // the ready projection replaces (the compact layout dropped group session
    // counts; the Ungrouped bucket row is the barrier).
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
  }, 120_000)

  afterEach(async () => {
    const failures: unknown[] = []
    try {
      expect({
        pageErrors: tripwire.pageErrors,
        slotErrors,
        warnings: tripwire.warnings,
      }).toEqual({
        pageErrors: [],
        slotErrors: [],
        warnings: [],
      })
    } catch (error) {
      failures.push(error)
    }
    await page?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'navigation case cleanup failed')
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'navigation e2e cleanup failed')
  })

  it.skipIf(MODE !== 'record')('records the two-turn seed live through the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-record'))
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    let sessionId: Awaited<ReturnType<WebScaffold['whenTurnSettled']>> | undefined
    for (const prompt of [PROMPT_TURN1, PROMPT_TURN2]) {
      const settled = scaffold.whenTurnSettled()
      // Turn 2 types into the same composer once turn 1 unlocks it.
      await expect.poll(() => input.isEnabled(), { timeout: 15_000 }).toBe(true)
      await input.fill(prompt)
      await input.press('Enter')
      sessionId = await settled
    }
    await recordFixture(scaffold, sessionId!, SEED)
    // Fixture honesty: the recording must contain the events the replay
    // scenarios assert on: three calls in turn 1 and two closed turns.
    const recorded = parseSessionLog(await readFile(SEED, 'utf8'))
    expect(recorded.filter(e => e.type === 'turn/end')).toHaveLength(2)
    const calls = recorded.filter((e): e is SessionEvent & { data: { name: string } } => e.type === 'tool/call')
    expect(calls.map(e => e.data.name).sort()).toEqual(['bash', 'read', 'read'])
  }, 400_000)

  it.skipIf(MODE === 'record')('finds an unopened seeded session by message content and opens it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-search'))
    // The API baselines can settle before React commits their projection. The
    // seeded Ungrouped bucket row is the final user-visible barrier before
    // editing search (the compact layout dropped group session counts).
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
    // Search is a collapsed header action; expand it so the input is actionable.
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    const search = page.getByPlaceholder('Search sessions', { exact: false })
    // The cold row has not been opened, so only the persisted log can satisfy
    // this query. First search lazily reconciles the SQLite content index.
    await search.fill('zzzqx-no-such-session')
    await page.getByText('No matching sessions').waitFor({ timeout: 30_000 })
    await expect.poll(
      () => page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').count(),
      { timeout: 10_000 },
    ).toBe(0)

    await search.fill('WATERFALL')
    const resultTree = page.getByRole('tree', { name: 'Search results' })
    const result = resultTree.getByRole('treeitem')
    await expect.poll(() => result.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => result.getByText('WATERFALL', { exact: false }).count(), {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1)
    const snapshot = (await captureStableAria(page, '[class*="listArea"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(SEARCH_EXPECTED, snapshot, MODE)

    await result.click()
    // Search navigation returns to the browser with the opened Session row exposed.
    await expect.poll(() => search.inputValue(), { timeout: 5_000 }).toBe('')
    const selectedRow = page.locator('[role="tree"][aria-label="Sessions"] [role="treeitem"][aria-selected="true"]')
    await expect.poll(() => selectedRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.getByText('FIRST_DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.getByRole('heading', { name: 'Navigation Summary' }).count(), { timeout: 15_000 }).toBe(1)
  }, 90_000)

  it.skipIf(MODE === 'record')('renders the trajectory ledger and opens its local record inspector', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-trajectory'))
    await ensureSeedOpen(page)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    await page.waitForTimeout(100)
    const overlayLayout = await page.getByRole('table').evaluate((table) => {
      const host = table.closest('[data-conversation-scroll]')
      const seat = host?.querySelector('[data-composer-seat]') ?? null
      const pane = table.parentElement
      return {
        hostPosition: host === null ? null : getComputedStyle(host).position,
        paneOverflowX: pane === null ? null : getComputedStyle(pane).overflowX,
        paneScrollableWidth: pane === null ? null : pane.scrollWidth - pane.clientWidth,
        seatPosition: seat === null ? null : getComputedStyle(seat).position,
      }
    })
    expect(overlayLayout).toEqual({
      hostPosition: 'relative',
      paneOverflowX: 'hidden',
      paneScrollableWidth: 0,
      seatPosition: 'absolute',
    })
    expect({
      pageErrors: tripwire.pageErrors,
      slotErrors,
      warnings: tripwire.warnings,
    }).toEqual({
      pageErrors: [],
      slotErrors: [],
      warnings: [],
    })
    // Turn rules partition the ledger without restoring a separate header row.
    await expect.poll(() => page.locator('tr[data-turn-start="true"]').count(), { timeout: 15_000 }).toBe(2)
    await expect.poll(() => page.getByRole('columnheader').count(), { timeout: 10_000 }).toBe(0)
    await page.locator('tr[data-kind="tool"]').first().click()
    const details = page.getByRole('complementary', { name: 'Event details' })
    await expect.poll(() => details.count(), { timeout: 10_000 }).toBe(1)
    expect(await details.getByRole('tabpanel').evaluate(panel => getComputedStyle(panel).overflowX))
      .toBe('hidden')
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const darkSummarySurfaces = await details.getByRole('heading', { name: 'Payload' }).evaluate(heading => ({
      heading: getComputedStyle(heading).backgroundColor,
      panel: getComputedStyle(heading.closest('[aria-label="Event details"]')!).backgroundColor,
    }))
    expect(darkSummarySurfaces.heading).toBe(darkSummarySurfaces.panel)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await page.getByRole('tab', { name: 'Result' }).click()
    await expect.poll(() => page.getByText('NAVIGATION_OK', { exact: false }).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    const assistantSpan = page.locator('[data-timeline-span="message"][data-assistant-timing="true"]').first()
    await assistantSpan.hover()
    const timingTooltip = page.getByRole('tooltip')
    await timingTooltip.waitFor({ timeout: 5_000 })
    await expect.poll(() => timingTooltip.textContent(), { timeout: 5_000 }).toMatch(/TTFT .* Decoding/)
    const assistantTimingStyle = await assistantSpan.evaluate(node => ({
      background: getComputedStyle(node).backgroundImage,
      ttft: getComputedStyle(node).getPropertyValue('--trajectory-assistant-ttft'),
    }))
    expect(assistantTimingStyle.background).toContain('linear-gradient')
    expect(assistantTimingStyle.ttft).toMatch(/%$/)
    const snapshot = (await captureStableAria(page, '[class*="viewArea"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TRAJECTORY_EXPECTED, snapshot, MODE)
    await details.getByRole('button', { name: 'Close details' }).click()
  }, 60_000)

  it.skipIf(MODE === 'record')('retains interrupted imports through the real persistence composition', async () => {
    const interruptedId = SessionId('navigation-interrupted-import')
    const transaction = await scaffold.ctx.sessionPersistence.beginImport({
      version: SESSION_FORMAT_VERSION, id: interruptedId, createdAt: Date.now(),
      isSeeded: false, delegationDepth: 0, cwd: scaffold.workspaceCwd,
      importLineage: { sourceSessionId: SessionId(SEED_ID), sourceDriverId: 'standard', importId: 'recovery-probe' } })
    const source = await scaffold.ctx.sessionPersistence.open(SessionId(SEED_ID), 'read')
    try { await transaction.handle.append(await source.read()) }
    finally { await source.close(); await transaction.handle.close() }
    const persistence = scaffold.ctx.sessionPersistence as JsonlSessionPersistence
    const interrupted = (await persistence.inspectPendingImports()).find(report => report.sessionId === interruptedId)!
    expect(interrupted).toMatchObject({ empty: false, outcome: 'unknown' })
    expect(await persistence.recoverPendingImport(interrupted, 'retain')).toBe('retained-outcome-unknown')
    await expect(persistence.recoverPendingImport(interrupted, 'discard-empty')).rejects.toThrow('outcome unknown')
    expect(await persistence.stat(interruptedId)).toBeUndefined()
    expect((await persistence.inspectPendingImports()).find(report => report.sessionId === interruptedId)).toEqual(interrupted)
  })

  it.skipIf(MODE === 'record')('protects archive downloads and preview with owner authentication and request trust', async () => {
    await ensureSeedOpen(page)
    const base = new URL(scaffold.authenticatedUrl)
    const exportUrl = new URL('/api/session.export', base)
    exportUrl.searchParams.set('sessionId', SEED_ID)
    const cookie = (await page.context().cookies()).find(value => value.name.startsWith('dsh-auth-'))
    if (cookie === undefined) throw new Error('test owner cookie missing')
    const sessionsBefore = (await scaffold.ctx.sessionPersistence.list()).map(item => item.header.id).sort()
    const effects: string[] = []
    const removeModel = scaffold.ctx.on('llm/stream', (_options, next) => { effects.push('model'); return next() })
    const removeTool = scaffold.ctx.on('tools/execute', (_execution, next) => { effects.push('tool'); return next() })
    try {
      for (const query of ['', 'format=log', 'includeWorkspace=true']) {
        const url = new URL(exportUrl)
        for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value)
        for (const method of ['GET', 'HEAD']) {
          for (const headers of [{}, { cookie: `${cookie.name}=invalid-signature` }]) {
            const response = await fetch(url, { method, headers })
            expect(response.status).toBe(401)
            expect(await response.text()).toBe(method === 'HEAD' ? '' : 'unauthorized')
          }
          for (const headers of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }, { host: 'foreign.invalid' }]) {
            const response = await page.context().request.fetch(url.href, { method, headers })
            expect(response.status()).toBe(403)
            expect(await response.text()).toBe(method === 'HEAD' ? '' : 'forbidden')
          }
        }
      }
      const allowed = await page.context().request.get(exportUrl.href)
      expect(allowed.status()).toBe(200)
      const files = unzipSync(await allowed.body())
      expect(strFromU8(files['agent/context.json'] as Uint8Array)).toContain('FIRST_DONE')
      const source = JSON.parse(strFromU8(files['agent/driver.json'] as Uint8Array)) as {
        driver: { id: string }
        model: { provider: string; id: string }
      }
      const previewUrl = new URL('/api/session.import.preview', base)
      previewUrl.searchParams.set('driverId', source.driver.id)
      previewUrl.searchParams.set('provider', source.model.provider)
      previewUrl.searchParams.set('model', source.model.id)
      for (const cookieHeader of [undefined, `${cookie.name}=invalid-signature`]) {
        const response = await fetch(previewUrl, { method: 'POST', body: 'invalid zip',
          headers: { 'content-type': 'application/zip', ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }) } })
        expect(response.status).toBe(401)
        expect(await response.text()).toBe('unauthorized')
      }
      for (const headers of [{ origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' }, { host: 'foreign.invalid' }]) {
        const response = await page.context().request.post(previewUrl.href, { data: 'invalid zip',
          headers: { 'content-type': 'application/zip', ...headers } })
        expect(response.status()).toBe(403)
        expect(await response.text()).toBe('forbidden')
      }
      const invalid = await page.context().request.post(previewUrl.href, { data: 'invalid zip', headers: { 'content-type': 'application/zip' } })
      expect(invalid.status()).toBe(422)
      const preview = await page.context().request.post(previewUrl.href, { data: await allowed.body(), headers: { 'content-type': 'application/zip' } })
      expect(preview.status()).toBe(200)
      expect(effects).toEqual([])
      expect((await scaffold.ctx.sessionPersistence.list()).map(item => item.header.id).sort()).toEqual(sessionsBefore)
    } finally { removeModel(); removeTool() }
  })

  it.skipIf(MODE === 'record').each([
    { failCleanup: false, replaceExisting: false, failPublication: false },
    { failCleanup: true, replaceExisting: false, failPublication: false },
    { failCleanup: false, replaceExisting: true, failPublication: false },
    { failCleanup: true, replaceExisting: true, failPublication: false },
    { failCleanup: false, replaceExisting: true, failPublication: true },
  ])('exports an explicitly selected workspace through the real browser download, options=$failCleanup/$replaceExisting/$failPublication', async ({ failCleanup, replaceExisting, failPublication }) => {
    await ensureSeedOpen(page)
    const sourceSession = scaffold.ctx.sessions.get(SessionId(SEED_ID))
    const cwd = sourceSession?.header.cwd
    if (sourceSession === undefined || cwd === undefined) throw new Error('seed workspace is missing')
    // Imported copies have the same searchable conversation; give the original a unique visible title.
    seedSearchTitle = `Original ${SEED_ID}`
    scaffold.ctx.sessionTitle.rename(sourceSession, seedSearchTitle)
    await mkdir(join(cwd, 'snapshot-empty'), { recursive: true })
    await writeFile(join(cwd, '.snapshot-secret'), Buffer.from([0, 255, 12, 42]))
    const staging = await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-'))
    try {
      await page.getByRole('button', { name: 'Session log' }).click()
      const downloadPromise = page.waitForEvent('download')
      await page.getByRole('dialog', { name: 'Export unencrypted Session' })
        .getByRole('button', { name: 'Download ZIP with workspace (unencrypted)' }).click()
      const download = await downloadPromise
      const path = await download.path()
      const manifest = await validateDshSessionZip(path)
      expect(manifest.workspace.snapshot?.directories).toContain('workspace/snapshot-empty')
      expect(manifest.workspace.fingerprintAlgorithm).toBe('dsh-workspace-content-v1')
      await withDshWorkspaceSnapshot(path, manifest, staging, async (directory) => {
        expect(await readFile(join(directory, '.snapshot-secret'))).toEqual(Buffer.from([0, 255, 12, 42]))
        expect(await readdir(join(directory, 'snapshot-empty'))).toEqual([])
      })
      const state = JSON.parse(strFromU8(unzipSync(await readFile(path))['agent/driver.json'] as Uint8Array)) as AgentDriverStateV1
      const ports = scaffold.ctx.agents.getTransferPorts(state.driver.id)
      const effects: string[] = []
      const removeModel = scaffold.ctx.on('llm/stream', (_options, next) => { effects.push('model'); return next() })
      const removeTool = scaffold.ctx.on('tools/execute', (_execution, next) => { effects.push('tool'); return next() })
      try {
        const destination = join(staging, 'restored-project')
        if (replaceExisting) {
          await mkdir(destination)
          await writeFile(join(destination, 'user-existing.txt'), 'original workspace bytes')
        }
        const reviewed = await prepareDshSessionArchiveImport({ path, stagingParent: staging, catalog: sessionFormatCatalog,
          source: ports.source, target: ports.target, targetModel: state.model, store: scaffold.ctx.attachments,
          workspace: { action: 'apply-snapshot', path: destination },
          ...(failPublication ? { setup: () => { throw new Error('publication probe') } } : {}) })
        expect(reviewed.preview.workspace.targetExists).toBe(replaceExisting)
        expect(reviewed.replacesExistingWorkspace).toBe(replaceExisting)
        if (replaceExisting) {
          await expect(reviewed.commit(true)).rejects.toThrow('separate confirmation')
          expect(await readFile(join(destination, 'user-existing.txt'), 'utf8')).toBe('original workspace bytes')
        }
        if (failCleanup) {
          const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
          vi.mocked(rm).mockImplementation(async (path, options) => {
            if (String(path).startsWith(join(staging, '.dsh-workspace-'))) {
              expect(await scaffold.ctx.sessionPersistence.stat(reviewed.targetSessionId)).toBeDefined()
              throw Object.assign(new Error('post-publication cleanup probe'), { code: 'EACCES' })
            }
            return actual.rm(path, options)
          })
        }
        if (failPublication) {
          await expect(reviewed.commit(true, true)).rejects.toThrow('publication probe')
          expect(await scaffold.ctx.sessionPersistence.stat(reviewed.targetSessionId)).toBeUndefined()
          expect(await readdir(destination)).toEqual(['user-existing.txt'])
          expect(await readFile(join(destination, 'user-existing.txt'), 'utf8')).toBe('original workspace bytes')
          const journal = (await readdir(staging)).find(name => name.startsWith('.dsh-workspace-import-'))!
          expect((await inspectDshWorkspaceImport(join(staging, journal), scaffold.ctx.sessionPersistence)).outcome).toBe('rolled-back')
          expect(effects).toEqual([])
          return
        }
        const result = await reviewed.commit(true, replaceExisting)
        const { handle: imported, stagingCleanup } = result
        expect(await reviewed.commit(true, replaceExisting)).toBe(result)
        if (failCleanup) {
          expect(stagingCleanup?.path).toContain('.dsh-workspace-')
          expect(stagingCleanup?.cause).toBeInstanceOf(AggregateError)
          expect(await readdir(stagingCleanup!.path)).toContain('payloads')
        } else expect(stagingCleanup).toBeNull()
        try {
          const journalName = (await readdir(staging)).find(name => name.startsWith('.dsh-workspace-import-'))
          if (journalName === undefined) throw new Error('workspace recovery journal missing')
          const recovery = await inspectDshWorkspaceImport(join(staging, journalName), scaffold.ctx.sessionPersistence)
          expect(recovery.outcome).toBe('published')
          expect(recovery.record.targetSessionId).toBe(imported.agent.session.id)
          if (replaceExisting) {
            expect(result.workspaceBackup).not.toBeNull()
            expect(recovery.backup?.directory).toBe(result.workspaceBackup)
            expect(await readFile(join(result.workspaceBackup!, 'original', 'user-existing.txt'), 'utf8')).toBe('original workspace bytes')
            expect(await readFile(join(result.workspaceBackup!, 'workspace', 'user-existing.txt'), 'utf8')).toBe('original workspace bytes')
            expect(await readdir(destination)).not.toContain('user-existing.txt')
          } else expect(result.workspaceBackup).toBeNull()
          expect(await retainDshWorkspaceImport(recovery, scaffold.ctx.sessionPersistence)).toBe('published')
          expect(imported.agent.session.header.cwd).toBe(destination)
          expect(imported.agent.session.header.importLineage?.sourceSessionId).toBe(SEED_ID)
          expect(imported.agent.session.id).not.toBe(SEED_ID)
          expect(await readFile(join(destination, '.snapshot-secret'))).toEqual(Buffer.from([0, 255, 12, 42]))
          expect(await readdir(join(destination, 'snapshot-empty'))).toEqual([])
          expect(imported.agent.session.deriveMessages().map(message => message.content))
            .toEqual(scaffold.ctx.sessions.get(SessionId(SEED_ID))?.deriveMessages().map(message => message.content))
          expect(effects).toEqual([])
        } finally { await imported.dispose() }
      } finally { removeModel(); removeTool() }
    } finally {
      vi.mocked(rm).mockReset()
      await rm(staging, { recursive: true, force: true })
      await rm(join(cwd, 'snapshot-empty'), { recursive: true, force: true })
      await rm(join(cwd, '.snapshot-secret'), { force: true })
    }
  })

  it.skipIf(MODE === 'record')('downloads through the Session Header and /export with one dialog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-export'))
    await ensureSeedOpen(page)
    const exportButton = page.getByRole('button', { name: 'Session log' })
    expect(await exportButton.isDisabled()).toBe(false)
    const header = exportButton.locator('xpath=ancestor::header[1]')
    const [buttonBox, headerBox] = await Promise.all([
      exportButton.boundingBox(), header.boundingBox(),
    ])
    if (buttonBox === null || headerBox === null) {
      throw new Error('Session Header export geometry is unavailable')
    }
    expect(headerBox.x + headerBox.width - (buttonBox.x + buttonBox.width)).toBeLessThanOrEqual(32)
    const responsePromise = page.waitForResponse(response =>
      response.request().method() === 'HEAD'
      && new URL(response.url()).pathname === '/api/session.export', { timeout: 30_000 })
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await exportButton.click()
    const confirmation = page.getByRole('dialog', { name: 'Export unencrypted Session' })
    await confirmation.waitFor()
    await compareOrRefreshGolden(EXPORT_CONFIRMATION_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    // This historical seed has no durable driver selection; its explicit log-only choice remains available.
    await confirmation.getByRole('button', { name: 'Download log only (unencrypted)' }).click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    expect(new URL(response.url()).searchParams.get('format')).toBe('log')
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^dsh-session-.+\.zip$/)
    const dialog = page.getByRole('dialog', { name: 'Session download started' })
    await dialog.waitFor({ timeout: 30_000 })
    // The real host streamed the ZIP; its root entry is the persisted log
    // text verbatim (the assembled seam: real route, real persistence read).
    const files = unzipSync(await readFile(await download.path()))
    expect(Object.keys(files)).toEqual([EXPORTED_LOG_FILE])
    const content = strFromU8(files[EXPORTED_LOG_FILE] as Uint8Array)
    expect(JSON.parse(content.split('\n')[0] ?? '')).toMatchObject({
      type: 'session', version: SESSION_FORMAT_VERSION,
    })
    expect(content.split('\n')[0]).toContain(SEED_ID)
    expect(content).toContain('FIRST_DONE')
    await dialog.getByText('Close', { exact: true }).click()

    const observer = await newEnglishPage(browser)
    const observerTripwire = watchConsole(observer)
    const observerSlotErrors: string[] = []
    let observerDownloads = 0
    observer.on('download', () => { observerDownloads += 1 })
    observer.on('console', (message) => {
      if (message.type() === 'error' && /slot entry crashed/i.test(message.text())) {
        observerSlotErrors.push(message.text())
      }
    })
    const observerSessionBaseline = baselineResponse(observer)
    const [, observerSessionResponse] = await Promise.all([
      observer.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }),
      observerSessionBaseline,
    ])
    await assertBaselineSucceeded(observerSessionResponse, 'observer session.list')
    await observer.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
    await ensureSeedOpen(observer)

    try {
      const input = page.locator('[data-composer-input]').first()
      const slashDownloadPromise = page.waitForEvent('download', { timeout: 30_000 })
      await input.fill('/export')
      await page.getByRole('option', { name: /export/u }).waitFor({ timeout: 10_000 })
      await input.press('Enter')
      await page.getByRole('dialog', { name: 'Export unencrypted Session' })
        .getByRole('button', { name: 'Download portable ZIP (unencrypted)' }).click()
      const slashDownload = await slashDownloadPromise
      expect(slashDownload.suggestedFilename()).toBe(download.suggestedFilename())
      const slashFiles = unzipSync(await readFile(await slashDownload.path()))
      expect(Object.keys(slashFiles)).toEqual([EXPORTED_LOG_FILE, 'agent/driver.json', 'agent/context.json', 'manifest.json'])
      expect(strFromU8(slashFiles['agent/context.json'] as Uint8Array)).toContain('FIRST_DONE')
      const defaultUrl = new URL(response.url())
      defaultUrl.searchParams.delete('format')
      const defaultHead = await page.context().request.head(defaultUrl.href)
      expect(defaultHead.status()).toBe(200)
      expect((await defaultHead.body()).byteLength).toBe(0)
      const defaultExport = await page.context().request.get(defaultUrl.href)
      expect(defaultExport.status()).toBe(200)
      const defaultFiles = unzipSync(await defaultExport.body())
      expect(Object.keys(defaultFiles)).toContain('manifest.json')
      expect(strFromU8(defaultFiles['agent/context.json'] as Uint8Array)).toContain('FIRST_DONE')
      const archivedSource = JSON.parse(strFromU8(defaultFiles['agent/driver.json'] as Uint8Array)) as {
        driver: { id: string }
        model: { provider: string; id: string }
      }
      const previewUrl = new URL('/api/session.import.preview', defaultUrl)
      previewUrl.searchParams.set('driverId', archivedSource.driver.id)
      previewUrl.searchParams.set('provider', archivedSource.model.provider)
      previewUrl.searchParams.set('model', archivedSource.model.id)
      const unauthorizedPreview = await fetch(previewUrl.href, {
        method: 'POST', headers: { 'content-type': 'application/zip' }, body: new Uint8Array(await defaultExport.body()),
      })
      expect(unauthorizedPreview.status).toBe(401)
      const previewResponse = await page.context().request.post(previewUrl.href, {
        headers: { 'content-type': 'application/zip' }, data: await defaultExport.body(),
      })
      expect(previewResponse.status()).toBe(200)
      expect(await previewResponse.json()).toMatchObject({ targetDriverId: archivedSource.driver.id,
        workspace: { targetExists: false }, assessment: { fidelity: 'portable' } })
      const sourceManifest = JSON.parse(strFromU8(defaultFiles['manifest.json'] as Uint8Array)) as DshSessionArchiveManifestV1
      const directoryManifest = { ...sourceManifest, workspace: { sourceCwd: sourceManifest.workspace.sourceCwd,
        fingerprint: null, snapshot: { prefix: 'workspace', complete: true, directories: ['workspace/empty'] } } }
      const directoryPreviewUrl = new URL(previewUrl)
      directoryPreviewUrl.searchParams.set('workspace', scaffold.workspaceCwd)
      await writeFile(join(scaffold.workspaceCwd, 'empty'), 'keep existing file')
      const directoryPreview = await page.context().request.post(directoryPreviewUrl.href, {
        headers: { 'content-type': 'application/zip' }, data: Buffer.from(zipSync({ ...defaultFiles,
          'manifest.json': Buffer.from(JSON.stringify(directoryManifest)) })),
      })
      expect(directoryPreview.status()).toBe(200)
      const directoryReport = await directoryPreview.json() as {
        workspace: { warnings: string[]; choices: { action: string; fidelity: string }[] }
        workspaceEntries: { path: string; kind: string; status: string; conflictPath?: string }[]
      }
      expect(directoryReport.workspaceEntries).toContainEqual({ path: 'empty', kind: 'directory', status: 'type-conflict', conflictPath: 'empty' })
      expect(await readFile(join(scaffold.workspaceCwd, 'empty'), 'utf8')).toBe('keep existing file')
      await rm(join(scaffold.workspaceCwd, 'empty'))
      expect(directoryReport.workspace.warnings).not.toContain('snapshot-directories-unrecorded')
      expect(directoryReport.workspace.choices.find(choice => choice.action === 'apply-snapshot')?.fidelity).toBe('snapshot-content')
      const afterPreview = await page.context().request.get(defaultUrl.href)
      expect(strFromU8(unzipSync(await afterPreview.body())[EXPORTED_LOG_FILE] as Uint8Array))
        .toBe(strFromU8(defaultFiles[EXPORTED_LOG_FILE] as Uint8Array))
      const ports = scaffold.ctx.agents.getTransferPorts(archivedSource.driver.id)
      const targetId = SessionId('navigation-import-published')
      const reviewed = await prepareAgentTransfer(ports.source, ports.target, SessionId(SEED_ID), targetId, archivedSource.model)
      const preparation = await reviewed.commit(true)
      const publicationAbort = new AbortController()
      const removeFailure = scaffold.ctx.on('session/created', (session) => {
        if (session.id === targetId) publicationAbort.abort(new Error('import publication failure probe'))
      })
      try {
        await expect(ports.target.createImportedAgent(preparation, { cwd: scaffold.workspaceCwd, signal: publicationAbort.signal })
          .then(async (handle) => { await handle.dispose(); return 'unexpected import success' }))
          .rejects.toThrow('import publication failure probe')
      } finally { removeFailure() }
      expect(scaffold.ctx.agents.get(targetId)).toBeUndefined()
      expect(scaffold.ctx.sessions.get(targetId)).toBeUndefined()
      expect(await scaffold.ctx.sessionPersistence.stat(targetId)).toBeUndefined()
      const imported = await ports.target.createImportedAgent(preparation, { cwd: scaffold.workspaceCwd })
      try {
        expect(imported.agent.session.header.importLineage).toMatchObject({
          sourceSessionId: SEED_ID, sourceDriverId: archivedSource.driver.id, importId: reviewed.lineage.importId,
        })
        expect(scaffold.ctx.sessions.get(SessionId(SEED_ID))?.deriveMessages().map(message => message.content))
          .toEqual(scaffold.ctx.sessions.get(SessionId(SEED_ID))?.deriveMessages().map(message => message.content))
      } finally { await imported.dispose() }
      const staging = await mkdtemp(join(tmpdir(), 'dsh-navigation-import-'))
      const historicalEffects: string[] = []
      const removeModelProbe = scaffold.ctx.on('llm/stream', (_options, next) => { historicalEffects.push('model'); return next() })
      const removeToolProbe = scaffold.ctx.on('tools/execute', (_execution, next) => { historicalEffects.push('tool'); return next() })
      try {
        const archivePath = join(staging, 'source.zip')
        await writeFile(archivePath, await defaultExport.body(), { mode: 0o600 })
        const reviewedArchive = await prepareDshSessionArchiveImport({ path: archivePath, stagingParent: staging,
          catalog: sessionFormatCatalog, source: ports.source, target: ports.target, targetModel: archivedSource.model,
          store: scaffold.ctx.attachments, workspace: { action: 'keep-workspace', path: scaffold.workspaceCwd } })
        const { handle: archiveAgent, stagingCleanup } = await reviewedArchive.commit(true)
        expect(stagingCleanup).toBeNull()
        try {
          expect(archiveAgent.agent.session.id).toBe(reviewedArchive.targetSessionId)
          expect(archiveAgent.agent.session.id).not.toBe(SEED_ID)
          expect(archiveAgent.agent.session.header.importLineage).toMatchObject({
            sourceSessionId: SEED_ID, sourceDriverId: archivedSource.driver.id,
          })
          expect(archiveAgent.agent.session.deriveMessages().map(message => message.content))
            .toEqual(scaffold.ctx.sessions.get(SessionId(SEED_ID))?.deriveMessages().map(message => message.content))
          expect(historicalEffects).toEqual([])
          expect(await scaffold.ctx.sessionPersistence.stat(reviewedArchive.targetSessionId)).toBeDefined()
        } finally { await archiveAgent.dispose() }
      } finally { removeModelProbe(); removeToolProbe(); await rm(staging, { recursive: true, force: true }) }
      const slashContent = strFromU8(slashFiles[EXPORTED_LOG_FILE] as Uint8Array)
      expect(JSON.parse(slashContent.split('\n')[0] ?? '')).toMatchObject({
        type: 'session', version: SESSION_FORMAT_VERSION,
      })
      const slashEvents = parseSessionLog(slashContent)
      const exportRun = slashEvents.findLast(event => event.type === 'command/run' && event.data.name === 'export')
      if (exportRun?.type !== 'command/run') throw new Error('slash ZIP has no export command/run')
      const exportDone = slashEvents.find(event =>
        event.type === 'command/done' && event.data.commandId === exportRun.data.commandId)
      expect(exportDone?.type).toBe('command/done')
      await page.getByRole('dialog', { name: 'Session download started' }).waitFor({ timeout: 30_000 })
      await page.getByRole('dialog', { name: 'Session download started' })
        .getByText('Close', { exact: true }).click()
      await observer.getByText('Session log download requested.', { exact: true }).waitFor({ timeout: 30_000 })
      expect(observerDownloads).toBe(0)
      expect(await observer.getByRole('dialog', { name: 'Session download started' }).count()).toBe(0)
      expect(await observer.getByRole('dialog', { name: 'Export unencrypted Session' }).count()).toBe(0)
      expect({
        pageErrors: observerTripwire.pageErrors,
        slotErrors: observerSlotErrors,
        warnings: observerTripwire.warnings,
      }).toEqual({ pageErrors: [], slotErrors: [], warnings: [] })
    } finally {
      await observer.close()
    }
  }, 120_000)

  it.skipIf(MODE === 'record')('focuses the ledger by dragging an overview interval', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-timeline'))
    await ensureSeedOpen(page)
    await page.getByRole('tab', { name: 'Trajectory' }).click()
    const plot = page.getByLabel('Timeline overview; drag horizontally to focus events')
    await plot.waitFor({ timeout: 15_000 })
    const before = await page.locator('tr[data-kind]').count()
    const box = await plot.boundingBox()
    if (box === null) throw new Error('trajectory timeline plot has no layout box')
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
    await page.mouse.up()
    await expect.poll(() => page.locator('tr[data-timeline-focus="outside"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(0)
    await expect.poll(() => page.locator('tr[data-kind]').count(), { timeout: 10_000 }).toBe(before)
    await plot.click({ button: 'right' })
    await expect.poll(() => page.locator('tr[data-timeline-focus]').count(), { timeout: 10_000 }).toBe(0)
  }, 60_000)

  it.skipIf(MODE === 'record')('bash and file-path rows leave the default details column closed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-details'))
    await ensureSeedOpen(page)
    const bashRow = page.locator('[data-sample="bash"]').first()
    await expandOwningTurnProcess(page, bashRow)
    await bashRow.waitFor({ timeout: 15_000 })
    const frame = page.locator('[style*="grid-template-columns"]').first()
    expect(await frame.getAttribute('data-details-collapsed')).toBe('true')
    // The row click is the card's expand toggle (unified tool-row
    // interaction); it must not drive layout geometry either way.
    await bashRow.click()
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    // The card's own controls are outside the summary row and must not open
    // details either — the expanded terminal card is read in place.
    await page.locator('[data-sample="bash"] ~ div [data-terminal] [class*="_copyButton_"]').first().click()
    await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    // Read summaries are host-open file links; they also must not open details.
    const fileLink = page.locator('[data-variant="read"] button').first()
    await fileLink.waitFor({ timeout: 10_000 })
    const openPath = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath')
      .mockResolvedValue({ opened: true })
    try {
      await fileLink.click()
      await expect.poll(() => frame.getAttribute('data-details-collapsed'), { timeout: 5_000 }).toBe('true')
    } finally {
      openPath.mockRestore()
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('renders the bash row as a terminal card in the real browser', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-navigation-terminal'))
    await ensureSeedOpen(page)
    // The card is expand-gated behind the whole-row toggle (the unified
    // tool-row interaction): open it if this fresh view leaves it collapsed.
    // Expanded, the recorded command's own output sits in the message flow,
    // derived from the logged call/result presentations alone.
    const bashRow = page.locator('[data-sample="bash"]').first()
    await expandOwningTurnProcess(page, bashRow)
    await bashRow.waitFor({ timeout: 15_000 })
    if (await bashRow.getAttribute('aria-expanded') !== 'true') await bashRow.click()
    const card = page.locator('[data-sample="bash"] ~ div [data-terminal]').first()
    await card.waitFor({ timeout: 15_000 })
    // Real layout, not jsdom's stub (which computes no geometry at all):
    // squeeze the output pane below its content width and the line must keep
    // its single row and overflow sideways instead of folding. Soft-wrapping
    // here shreds the column alignment this card exists to hold.
    const layout = await card.locator('[class*="_output_"]').first().evaluate((node) => {
      const pane = node as HTMLElement
      const row = pane.querySelector<HTMLElement>('[class*="_line_"]')
      if (row === null) throw new Error('output pane has no line')
      const before = row.offsetHeight
      const restore = pane.style.width
      pane.style.width = '8px'
      const squeezed = { wrapped: row.offsetHeight > before, scrollsSideways: pane.scrollWidth > pane.clientWidth }
      pane.style.width = restore
      return { whiteSpace: getComputedStyle(row).whiteSpace, overflowX: getComputedStyle(pane).overflowX, ...squeezed }
    })
    expect(layout).toEqual({ whiteSpace: 'pre', overflowX: 'auto', wrapped: false, scrollsSideways: true })
    // The run-state dot's color is the whole point of it and is the one thing
    // jsdom cannot report: --dsw-* tokens resolve only against the real theme
    // stylesheet. This command settled cleanly, so the dot must be the green
    // success token — a red one here would read as a failed command.
    const dot = await card.locator('[class*="_runState_"][data-state]').first().evaluate((node) => {
      // The token lives on body, so the probe must sit in the same cascade.
      const probe = document.createElement('span')
      probe.style.color = 'var(--dsw-alias-state-success-primary)'
      document.body.appendChild(probe)
      const success = getComputedStyle(probe).color
      probe.remove()
      return {
        state: node.getAttribute('data-state'),
        color: getComputedStyle(node as HTMLElement).color,
        success,
        // One label per card (the state is the call's), so it hangs off the
        // prompt column rather than the row the dot sits in.
        label: node.closest('[class*="_prompt_"]')?.querySelector('[class*="_runStateLabel_"]')?.textContent ?? null,
        // The dot precedes the prompt label in document order, which is what
        // puts it to the left of the `$`.
        beforePrompt: node.compareDocumentPosition(node.parentElement!.querySelector('[class*="_cwd_"]')!)
          === Node.DOCUMENT_POSITION_FOLLOWING,
        // The dot lives in the card's OWN left padding, so it sits inside the
        // card box yet left of the prompt text. Owning the reservation as padding
        // rather than margin is what keeps a consumer's own margin from
        // cancelling it and letting a container clip the dot — geometry jsdom
        // cannot compute.
        insideCard: (node as HTMLElement).getBoundingClientRect().left
          >= (node.closest('[data-terminal]')?.getBoundingClientRect().left ?? Infinity),
        leftOfPrompt: (node as HTMLElement).getBoundingClientRect().right
          <= (node.closest('[class*="_promptLine_"]')
            ?.querySelector('[class*="_cwd_"]')
            ?.getBoundingClientRect().left ?? -Infinity),
      }
    })
    expect(dot.state).toBe('done')
    expect(dot.label).toBe('Done')
    expect(dot.beforePrompt).toBe(true)
    expect(dot.insideCard).toBe(true)
    expect(dot.leftOfPrompt).toBe(true)
    // Resolved through the theme token, not a literal hex in the component.
    expect(dot.success).toMatch(/^rgb/)
    expect(dot.color).toBe(dot.success)
    // Golden of the card at rest — captured before the copy click, whose
    // confirmation label self-reverts on a timer and would not hold still.
    const snapshot = (await captureStableAria(page, '[data-terminal]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TERMINAL_EXPECTED, snapshot, MODE)
    // Copy writes the raw output through the browser's own clipboard, which in
    // a real page is the async Clipboard API rather than the jsdom fallback.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await card.locator('[class*="_copyButton_"]').first().click()
    await expect.poll(() => card.locator('[class*="_copyButton_"]').first().textContent(), { timeout: 5_000 })
      .toBe('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('NAVIGATION_OK')
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the recorded fixture inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v2.jsonl', 'search-results.expected.md', 'trajectory.expected.md',
      'terminal-card.expected.md',
    ])
  })
})
