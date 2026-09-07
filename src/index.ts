#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { eventBus } from "./events.js";
import { host } from "./host.js";
import { relay } from "./relay.js";
import { eventLogInput, getEventLog } from "./tools/eventLog.js";
import { previewStateInput, queryPreviewState } from "./tools/previewState.js";
import { getRuntimeErrors, runtimeErrorsInput } from "./tools/runtimeErrors.js";
import { BRIDGE_VERSION, getSessionInfo } from "./tools/sessionInfo.js";
import { tailEvents, tailEventsInput } from "./tools/tail.js";
import { probeUpstream, upstreamFailure, upstreamGet, UPSTREAM_BASE } from "./upstream.js";

const SERVER_NAME = "preview-bridge";

/*
 * ROLE. Claude Code spawns one stdio child per session, but this server owns
 * two fixed ports and one browser page. Exactly one instance can hold the
 * ports; the rest read through it.
 *
 *   leader   — owns the WebSocket relay and the HTTP host, holds the event ring
 *   follower — owns nothing, answers every tool by asking the leader over HTTP
 *
 * Before this existed, a second session's child hit EADDRINUSE and exited 1,
 * which surfaced to the user only as "Connection closed" and never recovered
 * while the first session lived.
 */
type Role = "leader" | "follower";
let role: Role = "leader";

async function tryBecomeLeader(): Promise<boolean> {
  try {
    await relay.start();
  } catch {
    return false;
  }
  try {
    await host.start();
  } catch {
    // Half-bound is not a state anyone should be in: release the relay so the
    // real leader's ports stay consistent and this instance can follow cleanly.
    relay.stop();
    return false;
  }
  return true;
}

/**
 * A follower watches for the leader going away — the ordinary case being the
 * other Claude session simply ending. Without this, every follower would keep
 * proxying to a dead port forever and the ports would sit unclaimed with live
 * instances that could have taken them.
 */
function watchForPromotion(): void {
  const timer = setInterval(() => {
    void (async () => {
      if (role !== "follower") return;
      if (await probeUpstream(1000)) return;      // leader still there
      if (await tryBecomeLeader()) {
        role = "leader";
        clearInterval(timer);
        console.error("[preview-bridge] leader vanished; promoted this instance to leader");
        eventBus.publishPartial({
          source: "bridge",
          level: "system",
          kind: "session-connected",
          component: "bridge",
          message: "promoted from follower to leader",
          data: { bridgeVersion: BRIDGE_VERSION, pid: process.pid },
        });
      }
    })();
  }, 5000);
  // Never let the watchdog be the reason this process stays alive.
  timer.unref();
}

async function main(): Promise<void> {
  if (await tryBecomeLeader()) {
    role = "leader";
    console.error(`[preview-bridge] role=leader (pid ${process.pid})`);
  } else {
    const upstream = await probeUpstream();
    if (!upstream) {
      console.error(
        `[preview-bridge] fatal: ports are taken but ${UPSTREAM_BASE}/health is not a ` +
          "preview-bridge. Refusing to proxy to an unknown service. Free " +
          `PREVIEW_BRIDGE_HTTP_PORT/${process.env.PREVIEW_BRIDGE_RELAY_PORT ?? "relay"} or point this server at different ports.`,
      );
      process.exit(1);
    }
    role = "follower";
    console.error(
      `[preview-bridge] role=follower (pid ${process.pid}) → leader ` +
        `pid=${upstream.pid ?? "?"} v${upstream.version} at ${UPSTREAM_BASE}`,
    );
    watchForPromotion();
  }

  // Seed an initial bridge-version event so eventCount > 0 in fresh sessions
  eventBus.publishPartial({
    source: "bridge",
    level: "system",
    kind: "session-disconnected",
    component: "bridge",
    message: `preview-bridge ${BRIDGE_VERSION} ready as ${role} (no clients yet)`,
    data: { bridgeVersion: BRIDGE_VERSION, role },
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );

  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });

  /** Run the local implementation as leader, or ask the leader as follower. */
  async function serve(
    local: () => unknown | Promise<unknown>,
    path: string,
    params: Record<string, string | number | undefined>,
    timeoutMs?: number,
  ) {
    if (role === "leader") return json(await local());
    try {
      return json(await upstreamGet(path, params, timeoutMs));
    } catch (err) {
      return json(upstreamFailure(err));
    }
  }

  server.registerTool(
    "get_event_log",
    {
      description:
        "Returns recent BridgeEvents from the live preview, ring-buffered (500 entries). " +
        "Optional filters: source (iframe/host/bridge), level (debug/info/warn/error/system), kind. " +
        "Pagination via 'since' (event id cursor). `bridge-reinstalled` events are filtered out by default; pass kind:'bridge-reinstalled' to see them.",
      inputSchema: eventLogInput,
    },
    async (args) =>
      serve(() => getEventLog(args), "/events", {
        source: args.source,
        level: args.level,
        kind: args.kind,
        since: args.since,
        limit: args.limit,
      }),
  );

  server.registerTool(
    "get_runtime_errors",
    {
      description:
        "Returns recent runtime errors and unhandled-rejection events from the preview iframe. " +
        "Each error includes message, stack, file, line, column when available. Use this when " +
        "the user reports a broken preview or you want to see what just crashed.",
      inputSchema: runtimeErrorsInput,
    },
    async (args) =>
      serve(() => getRuntimeErrors(args), "/errors", {
        limit: args.limit,
        sinceTs: args.sinceTs,
      }),
  );

  server.registerTool(
    "query_preview_state",
    {
      description:
        "Asks the connected browser page for a live state snapshot. Kinds: " +
        "'form' (all input/textarea/select values, password fields filtered), " +
        "'route' (current URL/pathname), 'selection' (highlighted text), " +
        "'focus' (focused element selector + value), 'all' (combined). " +
        "Times out in 800ms if no host page is connected.",
      inputSchema: previewStateInput,
    },
    async (args) =>
      serve(() => queryPreviewState(args), "/preview-state", {
        kind: args.kind,
        selector: args.selector,
      }),
  );

  server.registerTool(
    "tail_events",
    {
      description:
        "Long-poll: blocks until at least one event matching `kinds` arrives, OR maxWaitMs elapses. " +
        "Returns the matched events. Use to wait for specific runtime signals (route change, build complete, etc.) " +
        "without polling get_event_log. Default maxWaitMs=5000, max 30000.",
      inputSchema: tailEventsInput,
    },
    async (args) => {
      const maxWaitMs = args.maxWaitMs ?? 5000;
      return serve(
        () => tailEvents(args),
        "/tail",
        { kinds: args.kinds.join(","), maxWaitMs, limit: args.limit },
        // The proxy must outlive the poll it is proxying, or a follower would
        // report a timeout the leader never had.
        maxWaitMs + 5000,
      );
    },
  );

  server.registerTool(
    "get_session_info",
    {
      description:
        "Returns bridge connection state: whether a host page is connected, in which mode " +
        "(hosted-iframe vs top-level), the preview URL if known, total event count, and bridge version. " +
        "Use to verify the bridge is actually receiving data before relying on other tools.",
      inputSchema: {},
    },
    async () => {
      if (role === "leader") {
        return json({ ...getSessionInfo(), role, pid: process.pid });
      }
      // A follower reports the LEADER's session (that is the bridge holding the
      // page) but stamps `via` with its own identity, so the two are never
      // confused when two sessions compare notes.
      try {
        const leaderSession = await upstreamGet("/session", {});
        return json({
          ...(leaderSession as Record<string, unknown>),
          via: { role: "follower", pid: process.pid },
        });
      } catch (err) {
        return json(upstreamFailure(err));
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[preview-bridge] connected via stdio (v${BRIDGE_VERSION}, role=${role})`);

  let shuttingDown = false;
  const shutdown = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[preview-bridge] shutting down (${why})`);
    relay.stop();
    host.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  /*
   * THE LEAK THAT CAUSED THE OUTAGE. A stdio MCP server's lifetime is its
   * client's pipe, but this process only ever listened for signals. A client
   * that closes the pipe without signalling -- or whose signal is lost crossing
   * the PRoot boundary -- left a live process holding both ports with nothing
   * attached to it, and every subsequent session then failed to start forever.
   * Losing stdin means nobody can ask us anything, so there is no reason to
   * keep the ports.
   */
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.stdin.on("error", () => shutdown("stdin error"));
}

main().catch((err) => {
  console.error("[preview-bridge] fatal:", err);
  process.exit(1);
});
