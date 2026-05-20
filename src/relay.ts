import { WebSocketServer, WebSocket } from "ws";
import { eventBus } from "./events.js";
import type { BridgeEvent } from "./types.js";

const PORT = Number(process.env.PREVIEW_BRIDGE_RELAY_PORT ?? 5251);

interface PendingState {
  reqId: string;
  resolve: (snapshot: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ClientMeta {
  connectedAt: number;
  mode: "hosted-iframe" | "top-level" | "unknown";
  previewUrl: string | null;
}

class Relay {
  private _wss: WebSocketServer | null = null;
  private _clients = new Map<WebSocket, ClientMeta>();
  private _pending = new Map<string, PendingState>();
  private _reqCounter = 0;

  start(port: number = PORT): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      wss.on("error", (err) => {
        console.error(`[preview-bridge] relay error on port ${port}:`, err.message);
        reject(err);
      });
      wss.on("listening", () => {
        this._wss = wss;
        console.error(`[preview-bridge] relay listening on ws://127.0.0.1:${port}`);
        resolve(port);
      });
      wss.on("connection", (ws) => this._handleConnection(ws));
    });
  }

  stop(): void {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("relay shutting down"));
    }
    this._pending.clear();
    for (const [ws] of this._clients) ws.close();
    this._clients.clear();
    this._wss?.close();
    this._wss = null;
  }

  get connectionsOpen(): number {
    return this._clients.size;
  }

  /** Returns the meta of the most-recently-connected client (for session_info). */
  get latestClientMeta(): ClientMeta | null {
    let latest: ClientMeta | null = null;
    for (const meta of this._clients.values()) {
      if (!latest || meta.connectedAt > latest.connectedAt) latest = meta;
    }
    return latest;
  }

  /**
   * Broadcast a state-snapshot request to all connected clients.
   * Resolves with the first matching `state-snapshot` reply, or rejects on timeout.
   */
  requestState(kind: string, timeoutMs = 800): Promise<unknown> {
    if (this._clients.size === 0) {
      return Promise.reject(new Error("no clients connected"));
    }
    const reqId = `req-${Date.now()}-${this._reqCounter++}`;
    const payload = JSON.stringify({ type: "request-state-snapshot", reqId, kind });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error(`state-snapshot timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pending.set(reqId, { reqId, resolve, reject, timer });

      for (const [ws] of this._clients) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(payload);
          } catch {
            /* ignore per-client send errors; another client may answer */
          }
        }
      }
    });
  }

  private _handleConnection(ws: WebSocket): void {
    const meta: ClientMeta = {
      connectedAt: Date.now(),
      mode: "unknown",
      previewUrl: null,
    };
    this._clients.set(ws, meta);

    eventBus.publishPartial({
      source: "bridge",
      level: "system",
      kind: "session-connected",
      component: "relay",
      message: `client connected (total: ${this._clients.size})`,
      data: { connectionsOpen: this._clients.size },
    });

    ws.on("message", (raw) => this._handleMessage(ws, raw.toString()));
    ws.on("close", () => {
      this._clients.delete(ws);
      eventBus.publishPartial({
        source: "bridge",
        level: "system",
        kind: "session-disconnected",
        component: "relay",
        message: `client disconnected (total: ${this._clients.size})`,
        data: { connectionsOpen: this._clients.size },
      });
    });
    ws.on("error", (err) => {
      console.error("[preview-bridge] client ws error:", err.message);
    });
  }

  private _handleMessage(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    // State-snapshot response — match to a pending request
    if (m.type === "state-snapshot" && typeof m.reqId === "string") {
      const pending = this._pending.get(m.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this._pending.delete(m.reqId);
        pending.resolve(m.snapshot);
      }
      return;
    }

    // Handshake — host page or top-level bridge identifies itself
    if (m.type === "hello") {
      const meta = this._clients.get(ws);
      if (meta) {
        meta.mode =
          m.mode === "hosted-iframe" || m.mode === "top-level"
            ? m.mode
            : "unknown";
        meta.previewUrl = typeof m.previewUrl === "string" ? m.previewUrl : null;
      }
      return;
    }

    // Event from the page being observed
    if (m.type === "event" && m.event && typeof m.event === "object") {
      const incoming = m.event as Partial<BridgeEvent>;
      if (!incoming.kind || !incoming.source || !incoming.level || !incoming.component) {
        return;
      }
      eventBus.publishPartial({
        source: incoming.source,
        level: incoming.level,
        kind: incoming.kind,
        component: incoming.component,
        message: incoming.message ?? "",
        data: incoming.data,
      });
      return;
    }

    // Batched events
    if (m.type === "events" && Array.isArray(m.events)) {
      for (const incoming of m.events as Array<Partial<BridgeEvent>>) {
        if (!incoming.kind || !incoming.source || !incoming.level || !incoming.component) continue;
        eventBus.publishPartial({
          source: incoming.source,
          level: incoming.level,
          kind: incoming.kind,
          component: incoming.component,
          message: incoming.message ?? "",
          data: incoming.data,
        });
      }
      return;
    }
  }
}

export const relay = new Relay();
