import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relay } from "./relay.js";
import { getEventLog } from "./tools/eventLog.js";
import { getRuntimeErrors } from "./tools/runtimeErrors.js";
import { queryPreviewState } from "./tools/previewState.js";
import { BRIDGE_VERSION, getSessionInfo } from "./tools/sessionInfo.js";
import { tailEvents } from "./tools/tail.js";
import type { BridgeKind } from "./types.js";

const PORT = Number(process.env.PREVIEW_BRIDGE_HTTP_PORT ?? 5250);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dist/host.js → ../public
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function serveFile(res: http.ServerResponse, filePath: string, contentType: string): Promise<void> {
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType, ...corsHeaders });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain", ...corsHeaders });
    res.end("not found");
  }
}

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
  res.end(JSON.stringify(body));
}

/** Parse an integer query param, ignoring absent/garbage values. */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function strParam<T extends string>(url: URL, name: string): T | undefined {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : (raw as T);
}

class Host {
  private _server: http.Server | null = null;

  start(port: number = PORT): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on("error", (err) => {
        console.error(`[preview-bridge] host error on port ${port}:`, err.message);
        reject(err);
      });
      /*
       * /tail is a long poll of up to 30s. Node's default requestTimeout is 300s
       * and headersTimeout 60s, both comfortably clear, but the socket-level
       * keep-alive default (5s) would drop an idle tail connection mid-wait.
       */
      server.keepAliveTimeout = 35_000;
      server.listen(port, "127.0.0.1", () => {
        this._server = server;
        console.error(`[preview-bridge] host listening on http://127.0.0.1:${port}`);
        resolve(port);
      });
    });
  }

  stop(): void {
    this._server?.close();
    this._server = null;
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    /*
     * IDENTITY, not just liveness. A second instance that finds this port taken
     * has to decide whether to proxy to whatever is there, and "200 OK" is not
     * enough to justify forwarding a user's questions to a stranger's dev
     * server. `service` is the field that makes the decision safe.
     */
    if (url.pathname === "/health") {
      sendJson(res, {
        ok: true,
        service: "preview-bridge",
        version: BRIDGE_VERSION,
        pid: process.pid,
        connections: relay.connectionsOpen,
      });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      await serveFile(res, path.join(PUBLIC_DIR, "host.html"), "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/__bridge.js") {
      await serveFile(res, path.join(PUBLIC_DIR, "__bridge.js"), "application/javascript; charset=utf-8");
      return;
    }

    if (url.pathname === "/state") {
      const kind = url.searchParams.get("kind") ?? "all";
      const timeoutMs = Math.min(Number(url.searchParams.get("timeout") ?? 800), 5000);
      try {
        const snapshot = await relay.requestState(kind, timeoutMs);
        sendJson(res, { ok: true, kind, snapshot, capturedAt: Date.now() });
      } catch (err) {
        sendJson(res, {
          ok: false,
          kind,
          error: err instanceof Error ? err.message : "unknown error",
        });
      }
      return;
    }

    /*
     * The four endpoints below exist so a FOLLOWER instance can serve its MCP
     * tools from this leader's single event ring. Each returns byte-for-byte
     * what the corresponding tool function returns, so a follower's answer is
     * indistinguishable from a leader's -- if they diverged, the same question
     * would get different answers depending on which session asked, which is
     * exactly the class of bug that is impossible to notice and awful to debug.
     */
    if (url.pathname === "/events") {
      sendJson(res, getEventLog({
        source: strParam(url, "source"),
        level: strParam(url, "level"),
        kind: strParam(url, "kind"),
        since: url.searchParams.get("since") ?? undefined,
        limit: intParam(url, "limit"),
      }));
      return;
    }

    if (url.pathname === "/errors") {
      sendJson(res, getRuntimeErrors({
        limit: intParam(url, "limit"),
        sinceTs: intParam(url, "sinceTs"),
      }));
      return;
    }

    if (url.pathname === "/session") {
      // role/pid describe the instance that actually owns the relay, so a
      // follower proxying this can say whose event ring it is quoting.
      sendJson(res, { ...getSessionInfo(), role: "leader", pid: process.pid });
      return;
    }

    if (url.pathname === "/preview-state") {
      const kind = (url.searchParams.get("kind") ?? "all") as
        "form" | "route" | "selection" | "focus" | "all";
      sendJson(res, await queryPreviewState({
        kind,
        selector: url.searchParams.get("selector") ?? undefined,
      }));
      return;
    }

    if (url.pathname === "/tail") {
      const kinds = (url.searchParams.get("kinds") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as BridgeKind[];
      if (kinds.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: "kinds is required (comma-separated)" }));
        return;
      }
      sendJson(res, await tailEvents({
        kinds,
        maxWaitMs: intParam(url, "maxWaitMs"),
        limit: intParam(url, "limit"),
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain", ...corsHeaders });
    res.end("not found");
  }
}

export const host = new Host();
