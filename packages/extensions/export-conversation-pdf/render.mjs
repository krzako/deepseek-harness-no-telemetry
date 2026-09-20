#!/usr/bin/env node
/**
 * export-conversation renderer: HTML -> PDF via system Chromium/Chrome.
 * Usage: node render.mjs <input.html|spec.json> <output.pdf> [screenshot.png]
 *
 * Browser binaries and Linux shared libraries are intentionally NOT bundled
 * with this package. Install Chromium in the DSH image and optionally set
 * PUPPETEER_EXECUTABLE_PATH. Fonts remain embedded in the plugin so PDF text
 * rendering is deterministic across hosts.
 */
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chrome-headless-shell',
]

function isExecutable(path) {
  try { accessSync(path, fsConstants.X_OK); return true } catch { return false }
}

function resolveBrowserExecutable() {
  const configured = typeof process.env.PUPPETEER_EXECUTABLE_PATH === 'string'
    ? process.env.PUPPETEER_EXECUTABLE_PATH.trim()
    : ''
  if (configured !== '') {
    if (isExecutable(configured)) return configured
    throw new Error(`PUPPETEER_EXECUTABLE_PATH wskazuje na niedostępny plik: ${configured}`)
  }
  for (const candidate of CHROME_CANDIDATES) if (isExecutable(candidate)) return candidate
  throw new Error('Nie znaleziono Chromium/Chrome. Zainstaluj chromium w obrazie DSH i ustaw PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium.')
}

// Fonts: embedded as data URIs so rendering never depends on system fonts.
const FONT_DEFS = [
  { family: 'Inter', file: 'fonts/InterVariable.ttf', weight: '100 900', style: 'normal' },
  { family: 'Inter', file: 'fonts/InterVariable-Italic.ttf', weight: '100 900', style: 'italic' },
  { family: 'JetBrains Mono', file: 'fonts/JetBrainsMono.ttf', weight: '100 800', style: 'normal' },
  { family: 'Noto Color Emoji', file: 'fonts/NotoColorEmoji.ttf', weight: '400', style: 'normal' },
]

function fontCss() {
  return FONT_DEFS.map((f) => {
    const b64 = readFileSync(join(here, f.file)).toString('base64')
    return `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};src:url(data:font/ttf;base64,${b64}) format('truetype');}`
  }).join('\n')
}

const [inputPath, pdfPath, shotPath] = process.argv.slice(2)
if (!inputPath || !pdfPath) {
  console.error('usage: render.mjs <input.html|spec.json> <output.pdf> [screenshot.png]')
  process.exit(2)
}

let html
try {
  const raw = readFileSync(resolve(inputPath), 'utf8')
  if (/\.json$/i.test(inputPath)) {
    // Spec mode: { title, includeThinking, events } — build the document here.
    const spec = JSON.parse(raw)
    const logic = await import('./host-logic.mjs')
    const messages = logic.surfaceToMessages({ events: Array.isArray(spec.events) ? spec.events : [] }, spec.includeThinking === true, spec.includeWebSearch === true)
    if (messages.length === 0) {
      console.error('spec contains no exportable conversation entries')
      process.exit(1)
    }
    html = logic.buildHtml({ title: typeof spec.title === 'string' && spec.title !== '' ? spec.title : 'Rozmowa', messages, includeThinking: spec.includeThinking === true, includeWebSearch: spec.includeWebSearch === true })
  } else {
    html = raw
  }
} catch (err) {
  console.error(`cannot read input document: ${err.message}`)
  process.exit(1)
}

const css = fontCss()
if (/<head[^>]*>/i.test(html)) {
  html = html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>\n<style>${css}</style>`)
} else {
  html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`
}

const puppeteer = (await import('puppeteer-core')).default
let browser
try {
  const executablePath = resolveBrowserExecutable()
  const args = [
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--font-render-hinting=none',
  ]
  // Chrome refuses to run as root with its sandbox enabled. For non-root
  // containers we keep the sandbox unless the operator explicitly disables it.
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const forceNoSandbox = process.env.DSH_PDF_CHROME_NO_SANDBOX === '1'
  if (runningAsRoot || forceNoSandbox) args.push('--no-sandbox')

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args,
  })
} catch (err) {
  console.error(`chrome launch failed: ${err.message}`)
  process.exit(1)
}

try {
  const page = await browser.newPage()
  await page.setContent(html, { waitUntil: 'load' })
  try { await page.evaluate(() => document.fonts.ready) } catch { /* non-fatal */ }
  // Give bitmap (color emoji) font loading a moment to settle.
  await new Promise((r) => setTimeout(r, 200))

  if (shotPath) {
    await page.setViewport({ width: 900, height: 1400 })
    await page.screenshot({ path: resolve(shotPath), fullPage: true })
  }

  await page.pdf({
    path: resolve(pdfPath),
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;text-align:center;font-size:8.5px;color:#9aa3af;">' +
      'Strona <span class="pageNumber"></span> z <span class="totalPages"></span></div>',
    margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
  })
} catch (err) {
  console.error(`render failed: ${err.message}`)
  process.exitCode = 1
} finally {
  try { await browser.close() } catch { /* ignore */ }
}

if (process.exitCode === 0) console.log('PDF_OK ' + pdfPath)
