import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relay } from "./relay.js";

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

class Host {
  private _server: http.Server | null = null;

  start(port: number = PORT): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on("error", (err) => {
        console.error(`[preview-bridge] host error on port ${port}:`, err.message);
        reject(err);
      });
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

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ ok: true, connections: relay.connectionsOpen }));
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
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: true, kind, snapshot, capturedAt: Date.now() }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(
          JSON.stringify({
            ok: false,
            kind,
            error: err instanceof Error ? err.message : "unknown error",
          }),
        );
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain", ...corsHeaders });
    res.end("not found");
  }
}

export const host = new Host();
