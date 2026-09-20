// Pure host-side logic for the export-conversation plugin (tested standalone,
// then embedded verbatim in cordis_define code.host).

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatEmphasis(s) {
  // s is already HTML-escaped. Bold -> italic -> strikethrough -> links.
  let t = s
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*_])__([^_]+)__(?![*_])/g, '$1<strong>$2</strong>')
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  t = t.replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>')
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  t = t.replace(/\[([^\]\n]+)\]\(\s*(https?:[^)\s]+)(?:\s+["'][^)]*["'])?\)/g, (_m, txt, url) => {
    return '<a href="' + String(url).replace(/"/g, '%22') + '">' + txt + '</a>'
  })
  return t
}

export function inlineMd(s) {
  // s is already HTML-escaped; protect `code spans` from emphasis rules.
  let out = ''
  const re = /`([^`\n]+)`/g
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    out += formatEmphasis(s.slice(last, m.index)) + '<code>' + m[1] + '</code>'
    last = m.index + m[0].length
  }
  return out + formatEmphasis(s.slice(last))
}

export function renderBlocks(text) {
  const lines = String(text).split('\n')
  let html = ''
  let para = []
  let quote = []
  let fence = null // { lines: string[] } while inside a ``` block
  const listStack = [] // [{ type:'ul'|'ol', indent:number }]

  const flushPara = () => { if (para.length > 0) { html += '<p>' + inlineMd(esc(para.join('\n'))) + '</p>'; para = [] } }
  const flushQuote = () => { if (quote.length > 0) { html += '<blockquote><p>' + inlineMd(esc(quote.join('\n'))) + '</p></blockquote>'; quote = [] } }

  for (const raw of lines) {
    if (fence !== null) {
      if (/^\s{0,3}```/.test(raw)) { html += '<pre><code>' + esc(fence.lines.join('\n')) + '</code></pre>'; fence = null } else fence.lines.push(raw)
      continue
    }
    if (/^\s{0,3}```[^\n`]*$/.test(raw)) { flushPara(); flushQuote(); while (listStack.length > 0) html += '</' + listStack.pop().type + '>'; fence = { lines: [] }; continue }

    if (/^\s*$/.test(raw)) { flushPara(); flushQuote(); while (listStack.length > 0) html += '</' + listStack.pop().type + '>'; continue }

    const h = raw.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
    if (h !== null) { flushPara(); flushQuote(); while (listStack.length > 0) html += '</' + listStack.pop().type + '>'; const lvl = h[1].length; html += '<h' + lvl + '>' + inlineMd(esc(h[2].replace(/\s+#+\s*$/, ''))) + '</h' + lvl + '>'; continue }

    if (/^\s{0,3}([-*_])( *\1){2,}\s*$/.test(raw)) { flushPara(); flushQuote(); while (listStack.length > 0) html += '</' + listStack.pop().type + '>'; html += '<hr>'; continue }

    const q = raw.match(/^\s{0,3}> ?(.*)$/)
    if (q !== null) { flushPara(); while (listStack.length > 0) html += '</' + listStack.pop().type + '>'; quote.push(q[1]); continue }

    const li = raw.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/)
    if (li !== null) {
      flushPara(); flushQuote()
      const indent = li[1].replace(/\t/g, '  ').length
      const depth = Math.min(Math.floor(indent / 2), 3)
      const type = /^\d/.test(li[2]) ? 'ol' : 'ul'
      while (listStack.length > 0 && listStack[listStack.length - 1].indent > depth) html += '</' + listStack.pop().type + '>'
      const top = listStack[listStack.length - 1]
      if (!top || top.indent < depth) { html += '<' + type + '>'; listStack.push({ type, indent: depth }) }
      else if (top.type !== type) { html += '</' + top.type + '>'; listStack.pop(); html += '<' + type + '>'; listStack.push({ type, indent: depth }) }
      html += '<li>' + inlineMd(esc(li[3])) + '</li>'
      continue
    }

    flushQuote()
    while (listStack.length > 0) html += '</' + listStack.pop().type + '>'
    para.push(raw)
  }
  if (fence !== null) html += '<pre><code>' + esc(fence.lines.join('\n')) + '</code></pre>'
  flushPara(); flushQuote()
  while (listStack.length > 0) html += '</' + listStack.pop().type + '>'
  return html
}

export function renderPlain(text) {
  const paras = String(text).split(/\n{2,}/)
  let out = ''
  for (const p of paras) {
    const t = p.replace(/^\n+/, '').replace(/\n+$/, '')
    if (t !== '') out += '<p>' + esc(t) + '</p>'
  }
  return out
}

export function slug(s) {
  let out = String(s).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  if (out.length > 60) out = out.slice(0, 60).replace(/-+$/, '')
  return out === '' ? 'rozmowa' : out
}

export function fmtTime(t) {
  try {
    const d = new Date(Number(t))
    if (Number.isNaN(d.getTime())) return ''
    return new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
  } catch { return '' }
}

function messageHtml(m, includeThinking) {
  const isUser = m.role === 'user'
  const who = isUser ? 'Użytkownik' : 'Asystent'
  const time = fmtTime(m.time)
  const modelTag = !isUser && typeof m.model === 'string' && m.model !== '' ? '<span class="model-tag">' + esc(m.model) + '</span>' : ''
  let bodyHtml = ''
  for (const p of Array.isArray(m.parts) ? m.parts : []) {
    if (!p || typeof p !== 'object') continue
    const text = typeof p.text === 'string' ? p.text : ''
    if (p.type === 'image') { bodyHtml += '<p class="img-note">[załączony obraz]</p>'; continue }
    if (text === '') continue
    if (p.type === 'reasoning') {
      if (!includeThinking) continue
      bodyHtml += '<div class="thinking"><div class="tlabel">Myślenie modelu</div><div class="tbody">' + renderPlain(text) + '</div></div>'
    } else {
      bodyHtml += isUser ? renderPlain(text) : renderBlocks(text)
    }
  }
  if (bodyHtml === '') return ''
  const meta = '<span class="who">' + who + '</span>' + (time !== '' ? '<time>' + esc(time) + '</time>' : '') + modelTag
  return '<div class="msg ' + (isUser ? 'user' : 'assistant') + '"><div class="meta">' + meta + '</div><div class="body">' + bodyHtml + '</div></div>'
}

const DOC_CSS = `
  * { box-sizing: border-box; }
  body { font-family:'Inter','Noto Color Emoji',sans-serif; color:#1f2937; font-size:10.5pt; line-height:1.65; margin:0; }
  .doc-head { border-bottom:2px solid #4f46e5; padding-bottom:14px; margin-bottom:24px; }
  .doc-head h1 { font-size:20pt; font-weight:700; color:#111827; margin:0 0 6px; letter-spacing:-0.01em; line-height:1.25; }
  .doc-head .sub { font-size:9pt; color:#6b7280; margin:0; }
  .msg { margin-bottom:20px; }
  .msg .meta { display:flex; align-items:baseline; gap:10px; margin-bottom:5px; flex-wrap:wrap; }
  .who { font-size:9pt; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
  .msg.user .who { color:#4f46e5; }
  .msg.assistant .who { color:#0d9488; }
  time { font-size:8pt; color:#9ca3af; }
  .model-tag { font-size:8pt; color:#9ca3af; font-family:'JetBrains Mono','Noto Color Emoji',monospace; }
  .body { border-left:3px solid #e5e7eb; padding:2px 0 2px 14px; }
  .msg.user .body { border-color:#c7d2fe; background:#f8f9ff; padding-top:6px; padding-bottom:6px; border-radius:0 8px 8px 0; }
  .msg.assistant .body { border-color:#99f6e4; }
  p { margin:0 0 8px; white-space:pre-wrap; word-break:break-word; }
  h1,h2,h3,h4,h5,h6 { color:#111827; line-height:1.3; margin:14px 0 8px; font-weight:700; }
  .body h1 { font-size:15pt; } .body h2 { font-size:13pt; } .body h3 { font-size:11.5pt; }
  .body h4, .body h5, .body h6 { font-size:10.5pt; }
  code { font-family:'JetBrains Mono','Noto Color Emoji',monospace; font-size:8.7pt; background:#f3f4f6; border:1px solid #e5e7eb; padding:1px 5px; border-radius:4px; }
  pre { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 14px; margin:0 0 10px; overflow-wrap:anywhere; white-space:pre-wrap; word-break:break-word; }
  pre code { background:none; border:none; padding:0; font-size:8.5pt; line-height:1.6; color:#1e293b; }
  blockquote { margin:0 0 8px; padding:4px 0 4px 12px; border-left:3px solid #d1d5db; color:#4b5563; }
  ul,ol { margin:0 0 8px; padding-left:22px; }
  li { margin-bottom:3px; white-space:pre-wrap; word-break:break-word; }
  a { color:#4f46e5; text-decoration:none; }
  hr { border:none; border-top:1px solid #e5e7eb; margin:12px 0; }
  .img-note { color:#9ca3af; font-style:italic; }
  .thinking { margin-top:8px; border:1px dashed #cbd5e1; background:#f8fafc; border-radius:8px; padding:10px 14px; }
  .thinking .tlabel { font-size:7.5pt; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#94a3b8; margin-bottom:6px; }
  .thinking p, .thinking li { font-size:9pt; color:#475569; }
`

export function buildHtml({ title, messages, includeThinking }) {
  const times = []
  for (const m of messages) if (typeof m.time === 'number' && m.time > 0) times.push(m.time)
  let range = ''
  if (times.length > 0) range = fmtTime(Math.min.apply(null, times)) + ' – ' + fmtTime(Math.max.apply(null, times))
  const n = messages.length
  const word = n === 1 ? 'wiadomość' : 'wiadomości'
  let sub = 'Eksport rozmowy'
  if (range !== '') sub += ' · ' + range
  sub += ' · ' + n + ' ' + word
  if (includeThinking) sub += ' · z myśleniem modelu'

  let body = ''
  for (const m of messages) {
    const h = messageHtml(m, includeThinking)
    if (h !== '') body += h
  }

  return '<!doctype html>\n<html lang="pl">\n<head><meta charset="utf-8"><title>' + esc(title) + '</title>\n<style>' + DOC_CSS + '</style>\n</head>\n<body>\n' +
    '<header class="doc-head"><h1>' + esc(title) + '</h1><p class="sub">' + esc(sub) + '</p></header>\n' +
    body + '\n</body>\n</html>\n'
}

export function randomToken() {
  let s = ''
  for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

// Extract exportable messages from a cloned session surface snapshot.
export function surfaceToMessages(surface, includeThinking) {
  const events = Array.isArray(surface && surface.events) ? surface.events : []
  const out = []
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const time = typeof ev.time === 'number' ? ev.time : 0
    const data = ev.data
    if (!data || typeof data !== 'object') continue
    if (ev.type === 'user/message') {
      const src = data.source
      if (!src || src.kind !== 'user') continue // only direct human prompts
      const parts = []
      for (const b of Array.isArray(data.content) ? data.content : []) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') parts.push({ type: 'text', text: b.text })
        else if (b.type === 'image') parts.push({ type: 'image', text: '' })
      }
      if (parts.length > 0) out.push({ role: 'user', time, parts })
    } else if (ev.type === 'assistant/message') {
      const msg = data.message
      if (!msg || typeof msg !== 'object') continue
      const parts = []
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') parts.push({ type: 'text', text: b.text })
        else if (includeThinking && b.type === 'reasoning' && typeof b.text === 'string' && b.text !== '') parts.push({ type: 'reasoning', text: b.text })
      }
      const model = msg.source && typeof msg.source.model === 'string' ? msg.source.model : ''
      if (parts.length > 0) out.push({ role: 'assistant', time, parts, model })
    }
  }
  return out
}
