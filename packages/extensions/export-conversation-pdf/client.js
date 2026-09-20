window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-export-conversation-pdf", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const React = require("react");
const PANEL_CSS = ".xexp-hdr{display:inline-flex;align-items:center;gap:6px}.xexp-check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;user-select:none}.xexp-check input{accent-color:var(--dsw-alias-brand-primary,#4f46e5);width:13px;height:13px;margin:0;cursor:pointer}.xexp-hdr-btn{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#cbd5e1);background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font-size:11px;font-weight:600;cursor:pointer}.xexp-hdr-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f46e5);color:var(--dsw-alias-brand-primary,#4f46e5)}.xexp-hdr-btn:disabled{opacity:.6;cursor:default}.xexp-hdr-link{font-size:11px;font-weight:600;color:var(--dsw-alias-state-success-primary,#15803d);text-decoration:none;white-space:nowrap}.xexp-hdr-link:hover{text-decoration:underline}.xexp-hdr-error{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";
const PLUGIN_ID = "@deepseek-ai/dsh-export-conversation-pdf";
const STATUS_ROUTE = "/dsh/cordis/export-conversation/status";
let environmentAlertShown = false;

function showEnvironmentAlert(status) {
  if (environmentAlertShown || !status || status.ok === true) return;
  environmentAlertShown = true;
  const error = typeof status.error === "string" ? status.error : "Brakuje Chromium/Chrome lub wymaganych bibliotek systemowych.";
  const hint = typeof status.installHint === "string" ? status.installHint : "Zainstaluj Chromium i biblioteki w środowisku DSH, a następnie zrestartuj kontener.";
  window.alert("Eksport PDF nie jest dostępny.\n\n" + error + "\n\n" + hint);
}

async function probeEnvironment() {
  try {
    const resp = await window.fetch(STATUS_ROUTE, { method: "GET", headers: { Accept: "application/json" } });
    const body = await resp.json().catch(function () { return null; });
    if (resp.ok && body && body.ok !== true) showEnvironmentAlert(body);
  } catch (_) {
    // Host may still be starting. Export itself will surface a concrete error.
  }
}

function apply(ctx) {
  void probeEnvironment();
  const slots = ctx.get("slots");
  if (slots === undefined) return;

  // Style tag owned by this plugin id — the module loader removes it on unload.
  if (typeof document !== "undefined" && document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]') === null) {
    const tag = document.createElement("style");
    tag.dataset.plugin = PLUGIN_ID;
    tag.textContent = PANEL_CSS;
    document.head.appendChild(tag);
  }

  function getSessionId(props) {
    if (props && typeof props.sessionId === "string" && props.sessionId !== "") return props.sessionId;
    const snap = props && props.session ? props.session : null;
    if (snap && typeof snap.id === "string" && snap.id !== "") return snap.id;
    if (props && typeof props.id === "string" && props.id !== "") return props.id;
    return "";
  }

  async function doExportFetch(sessionId, includeThinking) {
    const url = "/dsh/cordis/export-conversation/trigger?sessionId=" + encodeURIComponent(sessionId) + "&thinking=" + (includeThinking ? "1" : "0");
    console.error("[xexp] trigger GET " + url);
    const resp = await window.fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    let body = null;
    try { body = await resp.json(); } catch (_) { body = null; }
    if (!resp.ok || !body || body.ok !== true) {
      if (body && body.environmentError === true) showEnvironmentAlert({ ok: false, error: body.error, installHint: "Zainstaluj Chromium/Chrome i jego biblioteki systemowe w obrazie DSH, a następnie przebuduj i zrestartuj kontener." });
      const msg = body && typeof body.error === "string" ? body.error : ("HTTP " + String(resp.status));
      console.error("[xexp] trigger failed: status=" + resp.status + " body=" + JSON.stringify(body));
      throw new Error(msg);
    }
    return { url: String(body.url || ""), filename: String(body.filename || "plik.pdf") };
  }

  function PdfHeaderAction(props) {
    const [includeThinking, setIncludeThinking] = React.useState(false);
    const [state, setState] = React.useState({ status: "idle", url: "", filename: "", error: "" });

    async function onExport() {
      if (state.status === "busy") return;
      const sessionId = getSessionId(props);
      if (sessionId === "") { console.error("[xexp] no session id; props keys=" + Object.keys(props || {}).join(",")); setState({ status: "error", url: "", filename: "", error: "Brak identyfikatora sesji w tym widoku." }); return; }
      setState({ status: "busy", url: "", filename: "", error: "" });
      try {
        const v = await doExportFetch(sessionId, includeThinking);
        if (v.url !== "") setState({ status: "done", url: v.url, filename: v.filename, error: "" });
        else setState({ status: "error", url: "", filename: "", error: "Eksport nie zwrócił adresu pobierania." });
      } catch (err) {
        const msg = String((err && err.message) || err);
        console.error("[xexp] export failed: " + msg);
        setState({ status: "error", url: "", filename: "", error: msg });
      }
    }

    const busy = state.status === "busy";
    return React.createElement("span", { className: "xexp-hdr" },
      React.createElement("label", { className: "xexp-check", title: "Dołącz myślenie modelu (thinking) do eksportu" },
        React.createElement("input", { type: "checkbox", checked: includeThinking, disabled: busy, onChange: function (e) { setIncludeThinking(e.target.checked === true); } }),
        React.createElement("span", null, "thinking"),
      ),
      React.createElement("button", { type: "button", className: "xexp-hdr-btn", onClick: onExport, disabled: busy, title: "Eksportuj rozmowę do PDF" }, busy ? "…" : "PDF"),
      state.status === "done" && React.createElement("a", { className: "xexp-hdr-link", href: state.url, download: state.filename, title: state.filename }, "Pobierz PDF"),
      state.status === "error" && React.createElement("span", { className: "xexp-hdr-error", title: state.error }, "✗ " + (state.error.length > 90 ? state.error.slice(0, 90) + "…" : state.error)),
    );
  }

  slots.inject("conversation.session.header.actions", function () { return slots.register({ name: "conversation.session.header.actions", id: "export-pdf-action" }, function (props) { return React.createElement(PdfHeaderAction, props); }); });
}

exports.apply = apply;
exports.inject = ["slots"];
return module.exports; } });
