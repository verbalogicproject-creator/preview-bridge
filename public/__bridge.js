/* preview-bridge __bridge.js — runs in the page being observed.
 *
 * Two modes, auto-detected:
 *   - iframe mode: posts events to window.parent via postMessage
 *   - top-level mode: opens its own WebSocket to ws://localhost:<port>
 *
 * Idempotent install. Captures:
 *   - window.onerror + window.onunhandledrejection -> runtime-error / unhandled-rejection
 *   - console.{log, warn, error} (wrapped, originals preserved) -> iframe-console
 *   - input/change on form fields (password type filtered at source) -> iframe-form-change
 *   - click on [data-bridge="track"] elements -> iframe-click
 *   - history.pushState wrap -> iframe-route-change
 *
 * Responds to {type:'request-state-snapshot', reqId, kind} from parent OR ws relay.
 */
(function () {
  "use strict";

  if (window.__PREVIEW_BRIDGE_INSTALLED) {
    const count = (window.__PREVIEW_BRIDGE_RELOAD_COUNT = (window.__PREVIEW_BRIDGE_RELOAD_COUNT || 0) + 1);
    emit("bridge-reinstalled", "system", "bridge", `reinstall #${count} (idempotent no-op)`, { count });
    return;
  }
  window.__PREVIEW_BRIDGE_INSTALLED = true;
  window.__PREVIEW_BRIDGE_RELOAD_COUNT = 0;

  const IS_TOP = window.parent === window;
  const MODE = IS_TOP ? "top-level" : "hosted-iframe";

  // ------- transport: top-level uses its own WebSocket; iframe posts to parent -------
  let ws = null;
  const HTTP_PORT = readPort("__PREVIEW_BRIDGE_HTTP_PORT", 5250);
  const WS_PORT = readPort("__PREVIEW_BRIDGE_WS_PORT", 5251);
  const eventQueue = [];

  function readPort(globalName, fallback) {
    if (typeof window[globalName] === "number") return window[globalName];
    const meta = document.querySelector(`meta[name="${globalName}"]`);
    if (meta) {
      const n = parseInt(meta.getAttribute("content") || "", 10);
      if (!isNaN(n)) return n;
    }
    return fallback;
  }

  function openWs() {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    } catch (e) {
      return;
    }
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello", mode: MODE, previewUrl: location.href }));
      // flush queued events
      while (eventQueue.length) {
        ws.send(JSON.stringify({ type: "event", event: eventQueue.shift() }));
      }
    });
    ws.addEventListener("message", (msg) => {
      let m;
      try { m = JSON.parse(msg.data); } catch { return; }
      if (m && m.type === "request-state-snapshot" && typeof m.reqId === "string") {
        const snapshot = collectSnapshot(m.kind || "all");
        try { ws.send(JSON.stringify({ type: "state-snapshot", reqId: m.reqId, snapshot })); } catch {}
      }
    });
    ws.addEventListener("close", () => {
      ws = null;
      // Try to reconnect once after 2s — useful across MCP restarts
      setTimeout(openWs, 2000);
    });
    ws.addEventListener("error", () => { /* close handler will trigger reconnect */ });
  }

  let _idCounter = 0;
  function nextId() { return `e${Date.now()}-${++_idCounter}`; }

  function emit(kind, level, component, message, data, source) {
    const event = {
      id: nextId(),
      ts: Date.now(),
      source: source || "iframe",
      level: level,
      kind: kind,
      component: component,
      message: message,
      data: data,
    };
    if (IS_TOP) {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: "event", event: event })); } catch {}
      } else {
        eventQueue.push(event);
        if (eventQueue.length > 100) eventQueue.shift();
      }
    } else {
      try { window.parent.postMessage({ __previewBridge: true, type: "event", event: event }, "*"); } catch {}
    }
    // Fan-out to in-page panel (no-op if panel isn't installed yet).
    try { if (typeof panelAppend === "function") panelAppend(event); } catch {}
  }

  // ------- iframe mode: listen for parent-relayed state requests -------
  if (!IS_TOP) {
    window.addEventListener("message", (ev) => {
      const m = ev.data;
      if (!m || !m.__previewBridge || m.type !== "request-state-snapshot") return;
      const snapshot = collectSnapshot(m.kind || "all");
      try {
        window.parent.postMessage(
          { __previewBridge: true, type: "state-snapshot", reqId: m.reqId, snapshot: snapshot },
          "*",
        );
      } catch {}
    });
  }

  // ------- error capture -------
  window.addEventListener("error", (ev) => {
    emit("runtime-error", "error", "window.onerror", String(ev.message || "error"), {
      message: ev.message,
      file: ev.filename,
      line: ev.lineno,
      column: ev.colno,
      stack: ev.error && ev.error.stack ? String(ev.error.stack) : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    emit("unhandled-rejection", "error", "promise", String(reason && reason.message ? reason.message : reason), {
      message: reason && reason.message ? String(reason.message) : String(reason),
      stack: reason && reason.stack ? String(reason.stack) : undefined,
    });
  });

  // ------- console proxy -------
  const VERBOSE = !!window.__PREVIEW_BRIDGE_VERBOSE ||
    (document.documentElement && document.documentElement.getAttribute("data-bridge") === "verbose");

  ["warn", "error"].forEach((method) => {
    const orig = console[method].bind(console);
    console[method] = function () {
      try {
        const args = Array.prototype.slice.call(arguments);
        emit("iframe-console", method === "error" ? "error" : "warn", `console.${method}`, args.map(stringifyArg).join(" "), {
          method: method,
          args: args.map(stringifyArg),
        });
      } catch {}
      return orig.apply(null, arguments);
    };
  });

  if (VERBOSE) {
    const origLog = console.log.bind(console);
    console.log = function () {
      try {
        const args = Array.prototype.slice.call(arguments);
        emit("iframe-console", "debug", "console.log", args.map(stringifyArg).join(" "), {
          method: "log",
          args: args.map(stringifyArg),
        });
      } catch {}
      return origLog.apply(null, arguments);
    };
  }

  // ------- input capture -------
  let inputTimer = null;
  let pendingInput = null;
  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (!isFormControl(t)) return;
    if (t.type === "password") return;
    pendingInput = t;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      if (!pendingInput) return;
      emit("iframe-form-change", "info", "input", `${describeEl(pendingInput)} = ${snippet(pendingInput.value)}`, {
        selector: describeEl(pendingInput),
        name: pendingInput.name || null,
        type: pendingInput.type || pendingInput.tagName.toLowerCase(),
        value: snippet(pendingInput.value),
      });
      pendingInput = null;
    }, 300);
  });

  // ------- click capture (opt-in via [data-bridge="track"]) -------
  document.addEventListener("click", (ev) => {
    const tracked = ev.target.closest && ev.target.closest('[data-bridge="track"]');
    if (!tracked) return;
    emit("iframe-click", "debug", "click", `clicked ${describeEl(tracked)}`, {
      selector: describeEl(tracked),
      text: snippet((tracked.textContent || "").trim(), 60),
      tag: tracked.tagName.toLowerCase(),
    });
  }, true);

  // ------- route change capture (pushState wrap) -------
  const origPush = history.pushState.bind(history);
  history.pushState = function () {
    const r = origPush.apply(history, arguments);
    emit("iframe-route-change", "info", "history.pushState", `route -> ${location.pathname}`, {
      url: location.href,
      pathname: location.pathname,
      search: location.search,
    });
    return r;
  };
  window.addEventListener("popstate", () => {
    emit("iframe-route-change", "info", "popstate", `route -> ${location.pathname}`, {
      url: location.href,
      pathname: location.pathname,
      search: location.search,
    });
  });

  // ------- state collection -------
  function collectSnapshot(kind) {
    const out = { kind: kind, capturedAt: Date.now() };
    if (kind === "form" || kind === "all") out.form = collectFormState();
    if (kind === "route" || kind === "all") out.route = {
      url: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    };
    if (kind === "focus" || kind === "all") out.focusedElement = describeFocused();
    if (kind === "selection" || kind === "all") out.selection = describeSelection();
    return out;
  }

  function collectFormState() {
    const result = {};
    const inputs = document.querySelectorAll("input, textarea, select");
    inputs.forEach((el) => {
      if (el.type === "password") return;
      const key = el.name || el.id || describeEl(el);
      if (el.type === "checkbox" || el.type === "radio") {
        result[key] = el.checked;
      } else if (el.tagName === "SELECT") {
        result[key] = el.value;
      } else {
        result[key] = snippet(el.value, 200);
      }
    });
    return result;
  }

  function describeFocused() {
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    const out = { tag: a.tagName.toLowerCase(), selector: describeEl(a) };
    if (isFormControl(a) && a.type !== "password") out.value = snippet(a.value, 200);
    return out;
  }

  function describeSelection() {
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.toString()) return null;
    return { text: snippet(sel.toString(), 200) };
  }

  // ------- utilities -------
  function isFormControl(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
  }

  function describeEl(el) {
    if (!el) return "(null)";
    if (el.id) return `#${el.id}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
    const cls = (el.className && typeof el.className === "string") ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
  }

  function snippet(s, max) {
    max = max || 100;
    s = String(s == null ? "" : s);
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  function stringifyArg(a) {
    if (typeof a === "string") return snippet(a, 200);
    try { return snippet(JSON.stringify(a), 200); } catch { return snippet(String(a), 200); }
  }

  // ===========================================================================
  // In-page Panel — "Look Into Runtime"
  //
  // Renders every event from emit() into a small fixed-position overlay so
  // mobile-without-DevTools users can see runtime errors / console output /
  // host-emitted events on the rendered page. The MCP relay is unaffected;
  // this is a *second* consumer of the same event stream.
  //
  // Architecture: see ~/.claude/plans/misty-wishing-avalanche.md
  // Convention: Aria DevHub / Plateng debug-console / preview-bridge panel
  //             are the same pattern at different scopes. This one is universal.
  // ===========================================================================

  const THEMES = {
    "retro-green": {
      bg: "rgba(0,0,0,0.95)", fg: "#00ff00", border: "#00ff00",
      error: "#ff5555", warn: "#ffaa00", info: "#00aaff",
      debug: "#888888", system: "#00ff00", accent: "#00ff00",
    },
    "amber-woodland": {
      bg: "rgba(40,28,18,0.96)", fg: "#f4d29c", border: "#b85c38",
      error: "#ff6b6b", warn: "#ffaa55", info: "#9bdcff",
      debug: "#a08868", system: "#d4a574", accent: "#d4a574",
    },
    "cool-slate": {
      bg: "rgba(20,24,32,0.96)", fg: "#dde3ec", border: "#4a5568",
      error: "#fc8181", warn: "#f6ad55", info: "#63b3ed",
      debug: "#a0aec0", system: "#68d391", accent: "#90cdf4",
    },
  };
  const DEFAULT_THEME = "retro-green";
  const PANEL_MAX_ROWS = 200;
  const TOAST_MS = 5000;
  const AUTO_SHOW_RECENT_MS = 30000;

  const _panelState = {
    host: null, shadow: null, panelEl: null, toggleEl: null,
    listEl: null, countEl: null, statusDotEl: null,
    rows: [],   // {event, el} pairs, newest first
    expanded: false,
    autoHideTimer: null,
    lastErrorTs: 0,
    autoShowEnabled: true,
    filters: { levels: new Set(["error","warn","info","debug","system"]),
               sources: new Set(["iframe","host","bridge"]) },
    searchText: "",
    groupByComponent: false,
  };

  function readThemeName() {
    const meta = document.querySelector('meta[name="__PREVIEW_BRIDGE_THEME"]');
    const name = meta && meta.getAttribute("content");
    return (name && THEMES[name]) ? name : DEFAULT_THEME;
  }

  function readAutoShow() {
    const meta = document.querySelector('meta[name="__PREVIEW_BRIDGE_AUTOSHOW"]');
    if (!meta) return true;
    return meta.getAttribute("content") !== "off";
  }

  function levelIcon(level) {
    return level === "error" ? "✕"
         : level === "warn"  ? "⚠"
         : level === "info"  ? "ℹ"
         : level === "debug" ? "·"
         : "◆"; // system
  }

  function installPanel() {
    if (_panelState.host) return; // idempotent
    if (document.getElementById("__pb_host")) return;
    if (!document.body) {
      // body not ready yet — defer
      document.addEventListener("DOMContentLoaded", installPanel, { once: true });
      return;
    }

    _panelState.autoShowEnabled = readAutoShow();
    const themeName = readThemeName();
    const t = THEMES[themeName];

    const host = document.createElement("div");
    host.id = "__pb_host";
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; bottom: 0; right: 0; pointer-events: none;";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; font-family: "Courier New", ui-monospace, monospace; }
      .root { pointer-events: none; }
      .pb-toggle {
        position: fixed; bottom: 8px; right: 8px; width: 36px; height: 36px;
        background: ${t.bg}; border: 1.5px solid ${t.border}; border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        color: ${t.fg}; font-size: 16px; font-weight: bold; cursor: pointer;
        pointer-events: auto; user-select: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      .pb-toggle:hover { transform: scale(1.05); }
      .pb-toggle .dot {
        position: absolute; top: 4px; right: 4px; width: 8px; height: 8px;
        border-radius: 50%; background: ${t.system};
      }
      .pb-toggle .dot.error { background: ${t.error}; }
      .pb-toggle .dot.warn  { background: ${t.warn}; }
      .pb-panel {
        position: fixed; bottom: 52px; right: 8px; width: 320px; height: 420px;
        background: ${t.bg}; border: 1.5px solid ${t.border}; border-radius: 6px;
        display: none; flex-direction: column; pointer-events: auto;
        color: ${t.fg}; font-size: 11px; line-height: 1.4;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }
      .pb-panel.open { display: flex; }
      .pb-header {
        padding: 6px 10px; border-bottom: 1px solid ${t.border};
        display: flex; align-items: center; justify-content: space-between;
        background: ${t.border}; color: #000; font-weight: bold; font-size: 10px;
      }
      .pb-header .title { letter-spacing: 0.5px; }
      .pb-header .count { font-weight: normal; opacity: 0.75; margin-left: 6px; }
      .pb-header button {
        background: rgba(0,0,0,0.25); color: inherit; border: none;
        padding: 2px 8px; font-size: 10px; cursor: pointer; border-radius: 3px;
        font-family: inherit; font-weight: bold;
      }
      .pb-toolbar {
        padding: 6px 8px; border-bottom: 1px solid ${t.border};
        display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
        background: rgba(0,0,0,0.2);
      }
      .pb-chip {
        padding: 1px 7px; font-size: 9px; border: 1px solid ${t.border};
        border-radius: 10px; cursor: pointer; user-select: none;
        background: rgba(0,0,0,0.25); color: ${t.fg};
      }
      .pb-chip.off { opacity: 0.35; }
      .pb-chip.lv-error  { border-color: ${t.error}; color: ${t.error}; }
      .pb-chip.lv-warn   { border-color: ${t.warn};  color: ${t.warn}; }
      .pb-chip.lv-info   { border-color: ${t.info};  color: ${t.info}; }
      .pb-chip.lv-debug  { border-color: ${t.debug}; color: ${t.debug}; }
      .pb-chip.lv-system { border-color: ${t.system};color: ${t.system}; }
      .pb-search {
        flex: 1; min-width: 80px; background: rgba(0,0,0,0.3); color: ${t.fg};
        border: 1px solid ${t.border}; padding: 2px 6px; font-size: 10px;
        font-family: inherit; border-radius: 3px; outline: none;
      }
      .pb-list {
        flex: 1; overflow-y: auto; padding: 4px 0;
        scrollbar-width: thin; scrollbar-color: ${t.border} transparent;
      }
      .pb-row {
        padding: 3px 10px; border-bottom: 1px solid rgba(255,255,255,0.05);
        cursor: pointer; display: flex; gap: 6px; align-items: flex-start;
        font-size: 10px;
      }
      .pb-row:hover { background: rgba(255,255,255,0.04); }
      .pb-row.lv-error   { color: ${t.error}; }
      .pb-row.lv-warn    { color: ${t.warn}; }
      .pb-row.lv-info    { color: ${t.info}; }
      .pb-row.lv-debug   { color: ${t.debug}; }
      .pb-row.lv-system  { color: ${t.system}; }
      .pb-row .icon { font-weight: bold; width: 12px; flex-shrink: 0; text-align: center; }
      .pb-row .ts { color: ${t.debug}; opacity: 0.7; font-size: 9px; flex-shrink: 0; }
      .pb-row .body { flex: 1; word-break: break-word; }
      .pb-row .comp { font-weight: bold; }
      .pb-row.expanded .data { display: block; }
      .pb-row .data {
        display: none; margin-top: 4px; padding: 4px 6px; font-size: 9px;
        background: rgba(0,0,0,0.4); border-radius: 3px; white-space: pre-wrap;
        color: ${t.fg}; opacity: 0.85; max-height: 140px; overflow-y: auto;
      }
      .pb-row.hidden { display: none; }
      .pb-row .group-count {
        background: ${t.accent}; color: #000; padding: 0 5px;
        border-radius: 8px; font-size: 9px; font-weight: bold;
      }
      .pb-footer {
        padding: 4px 8px; border-top: 1px solid ${t.border};
        display: flex; gap: 6px; align-items: center; font-size: 9px;
        background: rgba(0,0,0,0.2);
      }
      .pb-footer button {
        background: rgba(0,0,0,0.3); color: ${t.fg}; border: 1px solid ${t.border};
        padding: 2px 8px; font-size: 9px; cursor: pointer; border-radius: 3px;
        font-family: inherit;
      }
      .pb-footer button:hover { background: ${t.border}; color: #000; }
      .pb-empty { text-align: center; padding: 20px; opacity: 0.5; font-size: 10px; }
    `;
    shadow.appendChild(style);

    const root = document.createElement("div");
    root.className = "root";
    root.innerHTML = `
      <div class="pb-toggle" title="Bridge panel">
        <span>⌐</span>
        <span class="dot"></span>
      </div>
      <div class="pb-panel" role="region" aria-label="Preview bridge panel">
        <div class="pb-header">
          <span class="title">BRIDGE PANEL <span class="count">0</span></span>
          <button class="close-btn" title="Hide">×</button>
        </div>
        <div class="pb-toolbar">
          <span class="pb-chip lv-error"  data-filter="level" data-value="error">err</span>
          <span class="pb-chip lv-warn"   data-filter="level" data-value="warn">warn</span>
          <span class="pb-chip lv-info"   data-filter="level" data-value="info">info</span>
          <span class="pb-chip lv-debug"  data-filter="level" data-value="debug">dbg</span>
          <span class="pb-chip lv-system" data-filter="level" data-value="system">sys</span>
          <input class="pb-search" type="text" placeholder="search…" />
        </div>
        <div class="pb-list">
          <div class="pb-empty">No events yet.</div>
        </div>
        <div class="pb-footer">
          <button class="clear-btn">clear</button>
          <button class="export-btn">export</button>
          <button class="group-btn" title="Group by component">group</button>
          <span style="flex:1"></span>
          <span class="theme-name" style="opacity:0.6">${themeName}</span>
        </div>
      </div>
    `;
    shadow.appendChild(root);
    document.body.appendChild(host);

    _panelState.host = host;
    _panelState.shadow = shadow;
    _panelState.toggleEl = shadow.querySelector(".pb-toggle");
    _panelState.panelEl = shadow.querySelector(".pb-panel");
    _panelState.listEl = shadow.querySelector(".pb-list");
    _panelState.countEl = shadow.querySelector(".pb-header .count");
    _panelState.statusDotEl = shadow.querySelector(".pb-toggle .dot");

    // Restore persisted filter state
    try {
      const saved = sessionStorage.getItem("__pb_filters");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.levels) _panelState.filters.levels = new Set(parsed.levels);
        if (parsed.sources) _panelState.filters.sources = new Set(parsed.sources);
        if (typeof parsed.searchText === "string") _panelState.searchText = parsed.searchText;
        _panelState.groupByComponent = !!parsed.groupByComponent;
      }
    } catch {}
    refreshChips();
    const searchInput = shadow.querySelector(".pb-search");
    searchInput.value = _panelState.searchText;

    // Wire interactions
    _panelState.toggleEl.addEventListener("click", () => togglePanel());
    shadow.querySelector(".close-btn").addEventListener("click", () => setExpanded(false));
    shadow.querySelector(".clear-btn").addEventListener("click", clearVisible);
    shadow.querySelector(".export-btn").addEventListener("click", exportEvents);
    shadow.querySelector(".group-btn").addEventListener("click", () => {
      _panelState.groupByComponent = !_panelState.groupByComponent;
      persistFilters();
      renderAll();
    });
    shadow.querySelectorAll(".pb-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const value = chip.getAttribute("data-value");
        const filter = chip.getAttribute("data-filter");
        const set = filter === "level" ? _panelState.filters.levels : _panelState.filters.sources;
        if (set.has(value)) set.delete(value); else set.add(value);
        persistFilters();
        refreshChips();
        applyVisibility();
      });
    });
    searchInput.addEventListener("input", () => {
      _panelState.searchText = searchInput.value;
      persistFilters();
      applyVisibility();
    });

    updateConnectionStatus();
  }

  function togglePanel() { setExpanded(!_panelState.expanded); }
  function setExpanded(open) {
    _panelState.expanded = !!open;
    if (!_panelState.panelEl) return;
    _panelState.panelEl.classList.toggle("open", _panelState.expanded);
  }

  function persistFilters() {
    try {
      sessionStorage.setItem("__pb_filters", JSON.stringify({
        levels: Array.from(_panelState.filters.levels),
        sources: Array.from(_panelState.filters.sources),
        searchText: _panelState.searchText,
        groupByComponent: _panelState.groupByComponent,
      }));
    } catch {}
  }

  function refreshChips() {
    if (!_panelState.shadow) return;
    _panelState.shadow.querySelectorAll(".pb-chip").forEach((chip) => {
      const value = chip.getAttribute("data-value");
      const filter = chip.getAttribute("data-filter");
      const set = filter === "level" ? _panelState.filters.levels : _panelState.filters.sources;
      chip.classList.toggle("off", !set.has(value));
    });
  }

  function updateConnectionStatus() {
    if (!_panelState.statusDotEl) return;
    const isErrorRecent = Date.now() - _panelState.lastErrorTs < AUTO_SHOW_RECENT_MS;
    _panelState.statusDotEl.classList.toggle("error", isErrorRecent);
    _panelState.statusDotEl.classList.toggle("warn", !isErrorRecent && !(IS_TOP ? ws && ws.readyState === 1 : true));
  }

  function panelAppend(event) {
    if (!_panelState.host) return; // panel not installed yet — drop quietly
    // Hide the "No events" placeholder once we have data
    const empty = _panelState.listEl.querySelector(".pb-empty");
    if (empty) empty.remove();

    const row = document.createElement("div");
    row.className = `pb-row lv-${event.level || "info"}`;
    row.setAttribute("data-event-id", event.id);
    row.setAttribute("data-component", event.component || "");
    const ts = new Date(event.ts || Date.now()).toLocaleTimeString([], { hour12: false });
    const safeMsg = String(event.message || "");
    row.innerHTML = `
      <span class="icon">${levelIcon(event.level)}</span>
      <span class="ts">${ts}</span>
      <span class="body"><span class="comp">${escapeHtml(event.component || "?")}</span>: ${escapeHtml(safeMsg)}<div class="data"></div></span>
    `;
    // Tap → copy event JSON
    row.addEventListener("click", (ev) => {
      // Long-press (≥400ms) toggles expanded; quick tap copies JSON
      const isExpanded = row.classList.contains("expanded");
      if (ev.detail === 2) { // double-click: expand
        row.classList.toggle("expanded");
        if (!isExpanded) {
          const dataEl = row.querySelector(".data");
          dataEl.textContent = safeStringify(event.data);
        }
      } else {
        copyToClipboard(safeStringify(event)).catch(() => {});
      }
    });

    // Prepend (newest first)
    _panelState.listEl.insertBefore(row, _panelState.listEl.firstChild);
    _panelState.rows.unshift({ event, el: row });
    // Prune
    while (_panelState.rows.length > PANEL_MAX_ROWS) {
      const old = _panelState.rows.pop();
      if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
    if (_panelState.countEl) _panelState.countEl.textContent = String(_panelState.rows.length);

    // Per-row visibility check (filters/search may hide it)
    if (!isVisible(event)) row.classList.add("hidden");

    // Auto-show on error
    if (event.level === "error") {
      _panelState.lastErrorTs = Date.now();
      updateConnectionStatus();
      if (_panelState.autoShowEnabled && !_panelState.expanded) {
        setExpanded(true);
        clearTimeout(_panelState.autoHideTimer);
        _panelState.autoHideTimer = setTimeout(() => setExpanded(false), TOAST_MS);
      }
    }
  }

  function isVisible(event) {
    if (!_panelState.filters.levels.has(event.level)) return false;
    if (!_panelState.filters.sources.has(event.source)) return false;
    if (_panelState.searchText) {
      const q = _panelState.searchText.toLowerCase();
      const haystack = `${event.component || ""} ${event.message || ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  function applyVisibility() {
    _panelState.rows.forEach(({ event, el }) => {
      el.classList.toggle("hidden", !isVisible(event));
    });
  }

  function renderAll() {
    // Used when group-by toggles. For now, group-by is a no-op stub (visual
    // grouping requires DOM rebuild; deferred to a follow-up since the panel
    // works without it). Mark the button visually so it's clear group is on.
    if (!_panelState.shadow) return;
    const btn = _panelState.shadow.querySelector(".group-btn");
    if (btn) btn.style.background = _panelState.groupByComponent
      ? "rgba(255,255,255,0.15)" : "";
  }

  function clearVisible() {
    _panelState.rows.forEach(({ el }) => { if (el.parentNode) el.parentNode.removeChild(el); });
    _panelState.rows = [];
    if (_panelState.countEl) _panelState.countEl.textContent = "0";
    const empty = document.createElement("div");
    empty.className = "pb-empty";
    empty.textContent = "Cleared.";
    _panelState.listEl.appendChild(empty);
  }

  function exportEvents() {
    const lines = _panelState.rows
      .slice()
      .reverse() // oldest first for the export
      .map(({ event }) => {
        const ts = new Date(event.ts || Date.now()).toISOString();
        const parts = [`[${ts}] [${event.level}] ${event.source}/${event.component} ${event.kind}: ${event.message}`];
        if (event.data && Object.keys(event.data).length > 0) {
          parts.push(`    data: ${safeStringify(event.data)}`);
        }
        return parts.join("\n");
      });
    const text = `# preview-bridge panel export — ${new Date().toISOString()}\n# events: ${lines.length}\n\n${lines.join("\n\n")}`;
    copyToClipboard(text).then(() => {
      flashExport("copied " + lines.length + " events");
    }).catch(() => {
      flashExport("clipboard denied — see textarea below");
      showFallbackTextarea(text);
    });
  }

  function flashExport(msg) {
    if (!_panelState.shadow) return;
    const btn = _panelState.shadow.querySelector(".export-btn");
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }

  function showFallbackTextarea(text) {
    if (!_panelState.shadow) return;
    let ta = _panelState.shadow.querySelector("textarea.pb-fallback");
    if (!ta) {
      ta = document.createElement("textarea");
      ta.className = "pb-fallback";
      ta.style.cssText = "position: fixed; bottom: 480px; right: 8px; width: 320px; height: 140px; z-index: 2147483647; pointer-events: auto;";
      _panelState.shadow.appendChild(ta);
    }
    ta.value = text;
    ta.focus();
    try { ta.setSelectionRange(0, text.length); } catch {}
  }

  function copyToClipboard(text) {
    return navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error("clipboard API unavailable"));
  }

  function safeStringify(v) {
    try { return JSON.stringify(v, null, 2); }
    catch { return String(v); }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ===========================================================================
  // Public host-emit API
  //
  // Host pages call window.__previewBridge.emit() to inject custom events
  // (voice-tool-call, scene-state, animation-cue, anything) into the same
  // event ring that browser-native captures use. Same panel renders them;
  // same MCP relay ships them to Claude.
  // ===========================================================================
  window.__previewBridge = {
    emit: function (kind, level, component, message, data) {
      const safeKind = typeof kind === "string" && kind.length > 0 ? kind : "host-custom";
      const safeLevel = ["debug","info","warn","error","system"].indexOf(level) >= 0 ? level : "info";
      const safeComponent = typeof component === "string" && component.length > 0 ? component : "host";
      const safeMessage = (typeof message === "string") ? message : String(message);
      let safeData = data;
      try { JSON.stringify(safeData); }
      catch {
        emit("host-emit-warning", "warn", "preview-bridge", "host emit dropped non-serializable data field", { kind: safeKind, component: safeComponent });
        safeData = undefined;
      }
      emit(safeKind, safeLevel, safeComponent, safeMessage, safeData, "host");
    },
    show: function () { installPanel(); setExpanded(true); },
    hide: function () { setExpanded(false); },
    clearUI: function () { clearVisible(); },
    version: "0.2.0",
  };

  // ------- top-level mode: open the WS -------
  if (IS_TOP) {
    openWs();
  }

  // Install the panel after wiring so any emit() during install fans out correctly.
  installPanel();

  // Announce ourselves
  emit("session-connected", "system", "bridge", `preview-bridge installed in ${MODE} mode`, {
    mode: MODE,
    url: location.href,
    userAgent: navigator.userAgent,
  });
})();
