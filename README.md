# preview-bridge

A standalone MCP server that exposes live browser-preview state to Claude Code.

Lets Claude answer questions like:

- *"What's in the form on the page right now?"*
- *"The preview just errored — what was the message?"*
- *"What did the user click last?"*
- *"Wait until the next route change, then tell me."*

Works with any browser tab — frameworks-agnostic. Includes its own WebSocket relay and HTTP host page; no FastAPI, no Python, no `studio-v2` dependency.

---

## Architecture

3 layers, no backend dependency.

```
Claude Code ── MCP stdio ──> preview-bridge MCP server (Node)
                                      │
                                      ├── http://127.0.0.1:5250   serves /__bridge.js + host.html + /state + /health
                                      └── ws://127.0.0.1:5251     receives events + state-snapshot replies from the page
                                                      │
                                                      └── browser tab loaded with __bridge.js
                                                              ├── window.onerror / unhandledrejection
                                                              ├── console.{warn,error} (verbose mode: log too)
                                                              ├── form input + change
                                                              ├── click on [data-bridge="track"]
                                                              └── history.pushState wrap
```

500-entry ring buffer; all 5 MCP tools are read-only in v1.

---

## Install

Requires Node.js 20 or newer.

```sh
git clone https://github.com/verbalogicproject-creator/preview-bridge.git
cd preview-bridge
npm ci
npm run build
npm run smoke
npm run test:multi
```

The smoke test reports 17 passing assertions; the multi-session test reports
8 more. Then add the built server to your Claude Code MCP config (for example,
`~/.claude.json`), replacing `/absolute/path/to/preview-bridge` with this
checkout's absolute path:

```json
{
  "mcpServers": {
    "preview-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/preview-bridge/dist/index.js"],
      "env": {
        "PREVIEW_BRIDGE_HTTP_PORT": "5250",
        "PREVIEW_BRIDGE_RELAY_PORT": "5251"
      }
    }
  }
}
```

Restart Claude Code. `/mcp` should now show `preview-bridge` with 5 tools.

---

## Two usage modes

### (a) Bring-your-own-page mode (recommended)

Add one line to your app's HTML:

```html
<script src="http://127.0.0.1:5250/__bridge.js"></script>
```

`__bridge.js` auto-detects it's running top-level, opens a WebSocket to the bridge, and starts emitting events. No iframe wrapper needed.

### (b) Hosted-iframe mode

Open `http://127.0.0.1:5250/?app=<URL>` in a browser. The host page wraps `<URL>` in an iframe. **Important:** for cross-origin URLs the host cannot inject `__bridge.js` into the iframe automatically — the iframe's own HTML must include the script tag. Use mode (a) unless the app you're observing already includes `__bridge.js`.

---

## MCP tools

| Tool | Input | What it returns |
|------|-------|-----------------|
| `get_event_log` | `{ source?, level?, kind?, since?, limit? }` | Ring-buffered events, filtered |
| `get_runtime_errors` | `{ limit?, sinceTs? }` | Recent runtime + unhandled-rejection errors with stack/file/line |
| `query_preview_state` | `{ kind: 'form'\|'route'\|'selection'\|'focus'\|'all', selector? }` | Live snapshot from the connected page (800ms timeout) |
| `tail_events` | `{ kinds: BridgeKind[], maxWaitMs? }` | Long-poll: blocks until matching event arrives or timeout |
| `get_session_info` | `{}` | Bridge connection state, mode, event count |

### Composition pattern for "what is the user looking at right now"

```
1. get_session_info()                 → confirm bridge is connected
2. query_preview_state({kind:'all'})  → route + focused el + form + selection
3. get_event_log({source:'iframe', limit:20})  → user's recent path
```

---

## Event taxonomy

Single envelope, ARIA-shaped:

```typescript
interface BridgeEvent {
  id: string;                                            // monotonic
  ts: number;                                            // epoch ms
  source: 'iframe' | 'host' | 'bridge';
  level: 'debug' | 'info' | 'warn' | 'error' | 'system';
  kind: BridgeKind;
  component: string;
  message: string;
  data?: unknown;
}
```

Kinds: `session-connected`, `session-disconnected`, `runtime-error`, `unhandled-rejection`, `iframe-click`, `iframe-form-change`, `iframe-console`, `iframe-route-change`, `bridge-reinstalled`.

---

## Captured by default

- Errors and unhandled rejections
- `console.warn` + `console.error` (always)
- `console.log` — **only** when the page sets `<html data-bridge="verbose">` or `window.__PREVIEW_BRIDGE_VERBOSE = true` before `__bridge.js` loads
- Form input/change events (300ms debounce) on `<input>`, `<textarea>`, `<select>` — **`type=password` is filtered at source**
- Clicks on elements with `data-bridge="track"` (opt-in by the app)
- `history.pushState` and `popstate` for route changes

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PREVIEW_BRIDGE_HTTP_PORT` | 5250 | HTTP server port |
| `PREVIEW_BRIDGE_RELAY_PORT` | 5251 | WebSocket relay port |

---

## Privacy / hygiene

The bridge captures form values from the observed page. Password fields (`type=password`) are filtered at the `__bridge.js` source and never reach the wire. But **text/email/textarea/select fields are captured as typed**. Don't point the bridge at pages containing real credentials, PII, or secrets.

The ring buffer is in-memory only; nothing persists across MCP restarts. Events do not leave the local machine.

---

## Tests

```sh
npm run smoke
npm run test:multi
```

The smoke suite spawns the MCP, opens a simulated WebSocket client, and checks all five tools plus state snapshots, long-polling, and ring-buffer filtering. The multi-session suite verifies leader/follower proxying and promotion.

---

## Limits & known gaps

- **Cross-origin iframe injection**: the hosted-iframe mode (option b) can't inject `__bridge.js` into a cross-origin iframe. Use mode (a) for cross-origin scenarios.
- **No reverse channel in v1**: tools are read-only. No `inject_dom_command` yet. Future enhancement.
- **No screenshot capture**: visual state is out of scope (requires a headless-browser path not currently solved on Termux).
- **Single ring buffer**: 500 events, shared across all sessions. Multi-tab correlation (per-session ids) is future work.

---

## Roadmap

- Reverse channel (`inject_dom_command`)
- Session archive tool that drops a draft into gemini-expert's review queue once `propose_memory` ships
- Session replay UI in `host.html`
- Per-session correlation IDs

---

## Built on

- Ring-buffer + pub/sub primitive ported from ARIA's `RingBufferLogger`
- MCP server skeleton mirrors `gemini-expert/mcp-server/`
- Event-taxonomy philosophy inspired by Background Studio's functional-journey logging

---

## Multiple Claude Code sessions (leader / follower)

Claude Code spawns **one MCP child process per session**, but this server owns
two fixed ports and there is only ever **one browser page** being observed. So
instances elect a role at startup:

| Role | Owns | Answers tools by |
|---|---|---|
| `leader` | the WebSocket relay + HTTP host + the 500-entry event ring | reading its own ring |
| `follower` | nothing | asking the leader over HTTP (`/events`, `/errors`, `/session`, `/preview-state`, `/tail`) |

A follower's answers are the leader's answers — same ring, same page. `get_session_info`
reports the leader's state and stamps `via: {role:"follower", pid}` so the two are
never confused.

**What this fixes.** Before, the second session's child hit `EADDRINUSE`, called
`process.exit(1)`, and Claude Code reported only *"Connection closed"* — a totally
deterministic failure that looked like a flaky server and never recovered while
the first session lived.

Two further guarantees:

- **A follower promotes itself.** It polls the leader every 5s; when the leader's
  session ends, the follower binds the ports and takes over.
- **A leader dies with its client.** The process now exits on stdin EOF, not just
  on SIGINT/SIGTERM. Previously a client that closed the pipe without signalling
  left a live process holding both ports with *nothing attached to it*, which
  poisoned every future session permanently. This was the actual outage.

A follower refuses to proxy to a service that does not identify itself as
`preview-bridge` on `/health` — forwarding your questions to some other project's
dev server that happens to hold port 5250 would be worse than failing.
