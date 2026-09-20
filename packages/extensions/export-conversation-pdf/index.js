/**
 * @deepseek-ai/dsh-export-conversation-pdf — host half (persistent Cordis plugin).
 *
 * Exports the current conversation to PDF:
 *  - GET /dsh/cordis/export-conversation/trigger?sessionId=<id>&thinking=0|1&webSearch=0|1 -> JSON {ok,url,filename,error}
 *  - GET /dsh/cordis/export-conversation/file?token=<24 hex>                 -> PDF bytes (attachment)
 *  - model tool `export_conversation_pdf` ({includeThinking}) for the agent (/pdf, /pdf-thinking)
 *  - service `exportConversationPdf.export(args)` for other plugins
 *
 * The renderer is ./render.mjs next to this file (headless Chrome for Testing);
 * generated PDFs land in the session's workspace cwd when available, else a temp directory.
 */

import { spawn, spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { conversationPdfFilename, conversationStats, conversationTitle, webActivityKind } from './host-logic.mjs'

export const name = 'export-conversation-pdf'
export const inject = ['webServer', 'sessionQuery', 'tools']

const SUPPORT = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(tmpdir(), 'dsh-export-conversation-pdf')
const RENDER_SCRIPT = join(SUPPORT, 'render.mjs')
const FILE_ROUTE = '/dsh/cordis/export-conversation/file'
const TRIGGER_ROUTE = '/dsh/cordis/export-conversation/trigger'
const STATUS_ROUTE = '/dsh/cordis/export-conversation/status'
const DEBUG_LOG = '/tmp/export-debug.log'

/** token -> { path, filename }; capped at 25 (oldest evicted first). */
const downloads = new Map()

/** Injected sessionQuery service; bound in apply() before any request can arrive. */
let sessionQuery = null

function randomToken() {
  return randomBytes(12).toString('hex')
}


const CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chrome-headless-shell',
]

const DOCKER_INSTALL_HINT = [
  'Eksport PDF wymaga Chromium/Chrome zainstalowanego w środowisku DSH.',
  'Dla obrazu Debian/Bookworm dodaj do Dockerfile:',
  'RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-sandbox ca-certificates && rm -rf /var/lib/apt/lists/*',
  'ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium',
  'Następnie przebuduj obraz i zrestartuj kontener DSH.',
  'Jeśli sandbox Chromium jest blokowany przez profil kontenera, ustaw dodatkowo DSH_PDF_CHROME_NO_SANDBOX=1.',
].join('\n')

let rendererEnvironmentPromise = null

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveChromeExecutable() {
  const configured = typeof process.env.PUPPETEER_EXECUTABLE_PATH === 'string'
    ? process.env.PUPPETEER_EXECUTABLE_PATH.trim()
    : ''
  if (configured !== '') {
    if (await isExecutable(configured)) return { path: configured, configured: true }
    return { path: '', configured: true, error: `PUPPETEER_EXECUTABLE_PATH wskazuje na niedostępny plik: ${configured}` }
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (await isExecutable(candidate)) return { path: candidate, configured: false }
  }
  return { path: '', configured: false, error: 'Nie znaleziono Chromium/Chrome w standardowych lokalizacjach.' }
}

function lddMissingLibraries(executable) {
  const candidates = [executable]
  if (executable === '/usr/bin/chromium' || executable === '/usr/bin/chromium-browser') {
    candidates.push('/usr/lib/chromium/chromium')
  }
  for (const target of candidates) {
    const out = spawnSync('ldd', [target], { encoding: 'utf8', timeout: 10000 })
    const text = String(out.stdout || '') + '\n' + String(out.stderr || '')
    const missing = text.split(/\r?\n/).filter((line) => /=>\s+not found\b/.test(line)).map((line) => line.trim())
    if (missing.length > 0) return missing
  }
  return []
}

async function checkRendererEnvironment() {
  if (rendererEnvironmentPromise !== null) return rendererEnvironmentPromise
  rendererEnvironmentPromise = (async () => {
    let puppeteer
    try {
      puppeteer = (await import('puppeteer-core')).default
    } catch (err) {
      return {
        ok: false,
        code: 'puppeteer-core-missing',
        browser: '',
        error: 'Brakuje zależności npm puppeteer-core: ' + String((err && err.message) || err),
        installHint: 'Przebuduj DeepSeek Harness, aby zainstalować zależności wbudowanego pluginu PDF.',
      }
    }

    const resolved = await resolveChromeExecutable()
    if (resolved.path === '') {
      return { ok: false, code: 'chrome-missing', browser: '', error: resolved.error, installHint: DOCKER_INSTALL_HINT }
    }

    const missing = lddMissingLibraries(resolved.path)
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'chrome-libraries-missing',
        browser: resolved.path,
        error: 'Chromium ma brakujące biblioteki systemowe:\n' + missing.join('\n'),
        installHint: DOCKER_INSTALL_HINT,
      }
    }

    const version = spawnSync(resolved.path, ['--version'], { encoding: 'utf8', timeout: 10000 })
    if (version.error || version.status !== 0) {
      const detail = [version.error && version.error.message, version.stderr, version.stdout].filter(Boolean).join('\n').trim()
      return {
        ok: false,
        code: 'chrome-unusable',
        browser: resolved.path,
        error: 'Chromium/Chrome jest zainstalowany, ale nie daje się uruchomić.' + (detail ? '\n' + detail : ''),
        installHint: DOCKER_INSTALL_HINT,
      }
    }

    let browser
    try {
      const args = ['--disable-dev-shm-usage', '--hide-scrollbars']
      const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
      const forceNoSandbox = process.env.DSH_PDF_CHROME_NO_SANDBOX === '1'
      if (runningAsRoot || forceNoSandbox) args.push('--no-sandbox')
      browser = await puppeteer.launch({ headless: true, executablePath: resolved.path, timeout: 15000, args })
      await browser.close()
      browser = undefined
    } catch (err) {
      try { await browser?.close() } catch { /* ignore */ }
      return {
        ok: false,
        code: 'chrome-launch-failed',
        browser: resolved.path,
        error: 'Chromium/Chrome został znaleziony, ale testowy start headless nie powiódł się:\n' + String((err && err.message) || err),
        installHint: DOCKER_INSTALL_HINT,
      }
    }

    return {
      ok: true,
      code: 'ok',
      browser: resolved.path,
      version: String(version.stdout || version.stderr || '').trim(),
      error: '',
      installHint: '',
    }
  })()
  return rendererEnvironmentPromise
}

async function debugLog(line) {
  try {
    const stamp = new Date().toISOString() + ' ' + line
    await import('node:fs/promises').then(m => m.appendFile(DEBUG_LOG, stamp + '\n'))
  } catch { /* diagnostyka best-effort */ }
}

/** Spawn `node render.mjs <spec> <pdf>`; resolves null on success or a Polish error string. */
function runRenderer(scriptArgs) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(process.execPath, scriptArgs, { cwd: SUPPORT, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolvePromise('Nie udało się uruchomić renderera PDF: ' + String((err && err.message) || err))
      return
    }
    let stderr = ''
    child.stderr.on('data', (d) => { if (stderr.length < 262144) stderr += String(d) })
    const killer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 300000)
    child.on('error', (err) => { clearTimeout(killer); resolvePromise('Renderer PDF nie wystartował: ' + String((err && err.message) || err)) })
    child.on('close', (code) => {
      clearTimeout(killer)
      if (code === 0) return resolvePromise(null)
      const detail = stderr.trim().slice(-600)
      resolvePromise('Renderer PDF zakończył się kodem ' + String(code) + (detail !== '' ? ': ' + detail : ''))
    })
  })
}

/** Full export pipeline: read session -> spec JSON -> render.mjs -> tokenized download. */
async function doExport({ sessionId, includeThinking, includeWebSearch }) {
  const environment = await checkRendererEnvironment()
  if (!environment.ok) return { ok: false, url: '', filename: '', error: environment.error + '\n\n' + environment.installHint, environmentError: true }
  if (sessionId === '') return { ok: false, url: '', filename: '', error: 'Brak identyfikatora sesji.' }

  let log
  try { log = await sessionQuery.readSession(sessionId) } catch (err) {
    return { ok: false, url: '', filename: '', error: 'Nie udało się odczytać rozmowy: ' + String((err && err.message) || err) }
  }
  const allEvents = log && Array.isArray(log.events) ? log.events : []
  const title = conversationTitle(allEvents)
  const stats = conversationStats(allEvents)
  const cwd = log && log.session && typeof log.session.cwd === 'string' && log.session.cwd !== '' ? log.session.cwd : null
  // Pełna historia (raw log), nie tylko bieżąca powierzchnia — po kompaktacji
  // surface traci starsze wiadomości użytkownika, a eksport ma być wierny.
  const webSearchCallIds = new Set(allEvents
    .filter((ev) => ev && ev.type === 'tool/call' && webActivityKind(ev.data) === 'search')
    .map((ev) => String(ev.data.callId)))
  const events = allEvents.filter((ev) => {
    if (!ev) return false
    if (ev.type === 'user/message' || ev.type === 'assistant/message') return true
    if (!includeWebSearch) return false
    if (ev.type === 'tool/call') return webActivityKind(ev.data) !== null
    if (ev.type !== 'tool/result' || !ev.data || !ev.data.message) return false
    const source = ev.data.message.source
    return source && webSearchCallIds.has(String(source.callId))
  })
  if (events.length === 0) {
    return { ok: false, url: '', filename: '', error: 'Rozmowa jest pusta — brak wiadomości do wyeksportowania.' }
  }

  await mkdir(OUT_DIR, { recursive: true })

  const token = randomToken()
  const sessionStartedAt = log && log.session && typeof log.session.createdAt === 'number' && log.session.createdAt > 0
    ? log.session.createdAt
    : stats.startedAt
  const filename = conversationPdfFilename({
    startedAt: sessionStartedAt,
    title,
    messageCount: stats.messageCount,
    includeThinking: includeThinking === true,
    includeWebSearch: includeWebSearch === true,
  })
  const specPath = join(OUT_DIR, token + '.json')
  await writeFile(specPath, JSON.stringify({ title: title, includeThinking: includeThinking === true, includeWebSearch: includeWebSearch === true, events: events }), 'utf8')

  let pdfDir = cwd !== null ? cwd : OUT_DIR
  let pdfPath = join(pdfDir, filename)
  let err
  try {
    err = await runRenderer([RENDER_SCRIPT, specPath, pdfPath])
    if (err !== null && cwd !== null) {
      // Workspace dir may be unwritable — retry into the temporary fallback dir.
      pdfDir = OUT_DIR
      pdfPath = join(pdfDir, filename)
      err = await runRenderer([RENDER_SCRIPT, specPath, pdfPath])
    }
  } finally {
    await unlink(specPath).catch(() => undefined)
  }
  if (err !== null) return { ok: false, url: '', filename: '', error: err }

  const info = await stat(pdfPath).catch(() => undefined)
  if (info === undefined || !info.isFile()) return { ok: false, url: '', filename: '', error: 'Nie udało się wygenerować pliku PDF.' }

  downloads.set(token, { path: pdfPath, filename })
  while (downloads.size > 25) {
    const oldest = downloads.keys().next().value
    if (oldest === undefined) break
    const evicted = downloads.get(oldest)
    downloads.delete(oldest)
    if (evicted && dirname(evicted.path) === OUT_DIR) void unlink(evicted.path).catch(() => undefined)
  }
  return { ok: true, url: FILE_ROUTE + '?token=' + token, filename: filename, dir: pdfDir }
}

/** Download route: serves the PDF bytes for a live token. */
async function fileHandler(req, res) {
  const respond = (code, headers, body) => { try { res.writeHead(code, headers); res.end(body) } catch { /* połączenie zamknięte */ } }
  try {
    if (!req || String(req.method).toUpperCase() !== 'GET') return respond(405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Metoda niedozwolona — użyj GET.')
    const url = String((req && req.url) || '')
    const qIdx = url.indexOf('?')
    let token = ''
    if (qIdx >= 0) {
      for (const pair of url.slice(qIdx + 1).split('&')) {
        const eq = pair.indexOf('=')
        if (eq > 0 && pair.slice(0, eq) === 'token') { try { token = decodeURIComponent(pair.slice(eq + 1)) } catch { token = '' } break }
      }
    }
    const entry = downloads.get(token)
    if (entry === undefined) return respond(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Plik nie istnieje lub wygasł.')
    const bytes = await readFile(entry.path)
    return respond(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + entry.filename.replace(/"/g, '') + '"',
      'Content-Length': String(bytes.byteLength),
    }, bytes)
  } catch (err) {
    return respond(500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Błąd odczytu pliku: ' + String((err && err.message) || err))
  }
}


/** Environment probe used by the Web client to fail early with an actionable alert. */
async function statusHandler(req, res) {
  const respondJson = (code, obj) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* connection closed */ } }
  if (!req || String(req.method).toUpperCase() !== 'GET') return respondJson(405, { ok: false, code: 'method-not-allowed', error: 'Metoda niedozwolona — użyj GET.', installHint: '' })
  try {
    return respondJson(200, await checkRendererEnvironment())
  } catch (err) {
    return respondJson(500, { ok: false, code: 'environment-check-failed', browser: '', error: String((err && err.message) || err), installHint: DOCKER_INSTALL_HINT })
  }
}

/** Cross-plugin HTTP trigger used by the header widget (window.fetch). */
async function triggerHandler(req, res) {
  const respondJson = (code, obj) => { try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch { /* połączenie zamknięte */ } }
  await debugLog('TRIGGER-HIT method=' + String(req && req.method) + ' url=' + JSON.stringify(String((req && req.url) || '')))
  try {
    if (!req || String(req.method).toUpperCase() !== 'GET') return respondJson(405, { ok: false, url: '', filename: '', error: 'Metoda niedozwolona — użyj GET.' })
    const url = String((req && req.url) || '')
    const qIdx = url.indexOf('?')
    let sessionId = ''
    let thinking = false
    let webSearch = false
    if (qIdx >= 0) {
      for (const pair of url.slice(qIdx + 1).split('&')) {
        const eq = pair.indexOf('=')
        if (eq <= 0) continue
        const k = pair.slice(0, eq)
        let v = ''
        try { v = decodeURIComponent(pair.slice(eq + 1)) } catch { v = '' }
        if (k === 'sessionId') sessionId = v
        else if (k === 'thinking') thinking = v === '1' || v.toLowerCase() === 'true'
        else if (k === 'webSearch') webSearch = v === '1' || v.toLowerCase() === 'true'
      }
    }
    const result = await doExport({ sessionId: sessionId, includeThinking: thinking, includeWebSearch: webSearch })
    await debugLog('TRIGGER-DONE sessionId=[' + sessionId + '] thinking=' + String(thinking) + ' webSearch=' + String(webSearch) + ' ok=' + String(result.ok) + ' error=' + JSON.stringify(result.error || '') + ' url=' + JSON.stringify(result.url || ''))
    return respondJson(200, result)
  } catch (err) {
    await debugLog('TRIGGER-CATCH error=' + JSON.stringify(String((err && err.message) || err)))
    return respondJson(500, { ok: false, url: '', filename: '', error: String((err && err.message) || err) })
  }
}

/** Service entry point for other plugins (no HTTP involved). */
async function exportPdf(args) {
  try {
    if (!args || typeof args !== 'object') return { ok: false, url: '', filename: '', error: 'Nieprawidłowe argumenty eksportu.' }
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
    return await doExport({ sessionId: sessionId, includeThinking: args.includeThinking === true, includeWebSearch: args.includeWebSearch === true })
  } catch (err) {
    return { ok: false, url: '', filename: '', error: 'Błąd eksportu: ' + String((err && err.message) || err) }
  }
}

/**
 * Register routes, the model tool and the service. Every side effect is
 * fiber-scoped (disposers via ctx.effect / registry cleanup).
 * @param ctx - host context with webServer, sessionQuery and tools services.
 */
export function apply(ctx) {
  sessionQuery = ctx.sessionQuery
  void mkdir(OUT_DIR, { recursive: true }).catch(() => undefined)

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: FILE_ROUTE, handler: fileHandler }), 'export-pdf: file route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: TRIGGER_ROUTE, handler: triggerHandler }), 'export-pdf: trigger route')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STATUS_ROUTE, handler: statusHandler }), 'export-pdf: status route')

  // Resolve and cache the environment status at boot. The Web client also probes
  // STATUS_ROUTE and shows an alert when Chromium or its libraries are missing.
  void checkRendererEnvironment().then((status) => {
    if (!status.ok) console.error('[export-conversation-pdf] renderer unavailable: ' + status.error)
  })

  ctx.tools.register(defineTool({
    name: 'export_conversation_pdf',
    description: 'Exportuje bieżącą rozmowę z agentem do pliku PDF (A4, czytelny szablon, emotki zachowane). includeThinking=true dołącza bloki myślenia modelu. includeWebSearch=true dołącza zapytania i wyniki web_search oraz adresy pobrane przez web_fetch; obie opcje są domyślnie wyłączone. Używaj, gdy użytkownik prosi o eksport rozmowy do PDF — np. pisze /pdf lub /pdf-thinking albo wprost „wyeksportuj rozmowę”. Zwraca ok/url/filename; podaj użytkownikowi url jako klikalny link pobierania.',
    parameters: { includeThinking: { type: 'boolean' }, includeWebSearch: { type: 'boolean' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          filename: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : ''
      if (sessionId === '') return { ok: false, url: '', filename: '', error: 'Nie udało się ustalić identyfikatora sesji.' }
      const res = await doExport({ sessionId: sessionId, includeThinking: args && args.includeThinking === true, includeWebSearch: args && args.includeWebSearch === true })
      return {
        ok: res.ok === true,
        url: typeof res.url === 'string' ? res.url : '',
        filename: typeof res.filename === 'string' ? res.filename : '',
        error: typeof res.error === 'string' ? res.error : '',
      }
    },
  }))

  ctx.provide('exportConversationPdf', { export: (args) => exportPdf(args || {}) })
}
