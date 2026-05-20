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

  function emit(kind, level, component, message, data) {
    const event = {
      source: "iframe",
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

  // ------- top-level mode: open the WS -------
  if (IS_TOP) {
    openWs();
  }

  // Announce ourselves
  emit("session-connected", "system", "bridge", `preview-bridge installed in ${MODE} mode`, {
    mode: MODE,
    url: location.href,
    userAgent: navigator.userAgent,
  });
})();
