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

const SERVER_NAME = "preview-bridge";

async function main(): Promise<void> {
  // Boot order: relay first (it owns the connections), then host (proxies /state to relay)
  try {
    await relay.start();
  } catch (err) {
    console.error("[preview-bridge] fatal: cannot start WebSocket relay:", err);
    process.exit(1);
  }
  try {
    await host.start();
  } catch (err) {
    console.error("[preview-bridge] fatal: cannot start HTTP host:", err);
    relay.stop();
    process.exit(1);
  }

  // Seed an initial bridge-version event so eventCount > 0 in fresh sessions
  eventBus.publishPartial({
    source: "bridge",
    level: "system",
    kind: "session-disconnected",
    component: "bridge",
    message: `preview-bridge ${BRIDGE_VERSION} ready (no clients yet)`,
    data: { bridgeVersion: BRIDGE_VERSION },
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "get_event_log",
    {
      description:
        "Returns recent BridgeEvents from the live preview, ring-buffered (500 entries). " +
        "Optional filters: source (iframe/host/bridge), level (debug/info/warn/error/system), kind. " +
        "Pagination via 'since' (event id cursor). `bridge-reinstalled` events are filtered out by default; pass kind:'bridge-reinstalled' to see them.",
      inputSchema: eventLogInput,
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(getEventLog(args), null, 2) }],
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
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(getRuntimeErrors(args), null, 2) }],
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
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await queryPreviewState(args), null, 2) }],
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
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(await tailEvents(args), null, 2) }],
    }),
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
    async () => ({
      content: [{ type: "text", text: JSON.stringify(getSessionInfo(), null, 2) }],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[preview-bridge] connected via stdio (v${BRIDGE_VERSION})`);

  const shutdown = () => {
    console.error("[preview-bridge] shutting down");
    relay.stop();
    host.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[preview-bridge] fatal:", err);
  process.exit(1);
});
