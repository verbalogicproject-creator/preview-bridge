#!/usr/bin/env node
/**
 * preview-bridge smoke test.
 *
 * Boots the MCP via stdio, connects an MCP client, opens a WebSocket to the relay,
 * simulates a few events + a state-snapshot round-trip, and asserts the tool outputs.
 *
 * Run:  node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const HTTP_PORT = Number(process.env.PREVIEW_BRIDGE_HTTP_PORT ?? 5250);
const WS_PORT = Number(process.env.PREVIEW_BRIDGE_RELAY_PORT ?? 5251);

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${extra ? " — " + extra : ""}`); fail++; }
}

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${path}`);
  return res.json();
}

function callTool(client, name, args = {}) {
  return client.callTool({ name, arguments: args }).then((r) => {
    const text = r.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  });
}

async function main() {
  console.log("preview-bridge smoke test\n");

  console.log("→ Spawning MCP server...");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["./dist/index.js"],
    env: { ...process.env },
  });
  const client = new Client({ name: "smoke", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  // Give relay + host time to bind
  await sleep(500);

  console.log("\nTest 1: health endpoint");
  const health = await fetchJson("/health");
  check("GET /health returns ok:true", health.ok === true, JSON.stringify(health));

  console.log("\nTest 2: tool registration");
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  const expected = ["get_event_log", "get_runtime_errors", "get_session_info", "query_preview_state", "tail_events"];
  check("5 tools registered with correct names", JSON.stringify(names) === JSON.stringify(expected), `got: ${names.join(",")}`);

  console.log("\nTest 3: empty session info");
  const session0 = await callTool(client, "get_session_info");
  check("connectionsOpen === 0", session0.connectionsOpen === 0);
  check("mode === disconnected", session0.mode === "disconnected");
  check("bridgeVersion is a string", typeof session0.bridgeVersion === "string");

  console.log("\nTest 4: open a simulated browser WS");
  const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello", mode: "top-level", previewUrl: "http://example.test/" }));
  await sleep(100);

  const session1 = await callTool(client, "get_session_info");
  check("connectionsOpen === 1 after WS open", session1.connectionsOpen === 1);
  check("mode === top-level", session1.mode === "top-level");
  check("previewUrl === http://example.test/", session1.previewUrl === "http://example.test/");

  console.log("\nTest 5: publish a runtime-error event");
  ws.send(
    JSON.stringify({
      type: "event",
      event: {
        source: "iframe",
        level: "error",
        kind: "runtime-error",
        component: "window.onerror",
        message: "probe-42",
        data: { message: "probe-42", file: "app.js", line: 10, column: 4 },
      },
    }),
  );
  await sleep(100);

  const errs = await callTool(client, "get_runtime_errors", { limit: 5 });
  check("get_runtime_errors finds probe-42", errs.errors.some((e) => e.message === "probe-42"), JSON.stringify(errs.errors));

  console.log("\nTest 6: get_event_log filters work");
  const logAll = await callTool(client, "get_event_log", { limit: 50 });
  check("get_event_log returns events", logAll.events.length > 0);
  const logErrs = await callTool(client, "get_event_log", { level: "error", limit: 10 });
  check("level:error filter returns only error events", logErrs.events.every((e) => e.level === "error"));

  console.log("\nTest 7: state-snapshot round-trip");
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m && m.type === "request-state-snapshot") {
      ws.send(JSON.stringify({
        type: "state-snapshot",
        reqId: m.reqId,
        snapshot: { kind: m.kind, form: { email: "probe@verbalogic.test" }, capturedAt: Date.now() },
      }));
    }
  });
  const snap = await callTool(client, "query_preview_state", { kind: "form" });
  check("query_preview_state returns ok:true", snap.ok === true, JSON.stringify(snap));
  check("snapshot.form.email matches", snap.snapshot?.form?.email === "probe@verbalogic.test", JSON.stringify(snap.snapshot));

  console.log("\nTest 8: tail_events long-poll");
  const tailPromise = callTool(client, "tail_events", { kinds: ["iframe-route-change"], maxWaitMs: 3000 });
  await sleep(200);
  ws.send(
    JSON.stringify({
      type: "event",
      event: {
        source: "iframe",
        level: "info",
        kind: "iframe-route-change",
        component: "history.pushState",
        message: "route -> /probe",
        data: { url: "http://example.test/probe", pathname: "/probe" },
      },
    }),
  );
  const tailed = await tailPromise;
  check("tail_events receives the route-change", tailed.events.some((e) => e.kind === "iframe-route-change"), JSON.stringify(tailed));

  console.log("\nTest 9: bridge-reinstalled filtered out by default");
  ws.send(
    JSON.stringify({
      type: "event",
      event: { source: "iframe", level: "system", kind: "bridge-reinstalled", component: "bridge", message: "noise", data: {} },
    }),
  );
  await sleep(100);
  const filtered = await callTool(client, "get_event_log", { limit: 50 });
  check("bridge-reinstalled hidden by default", !filtered.events.some((e) => e.kind === "bridge-reinstalled"));
  const unfiltered = await callTool(client, "get_event_log", { kind: "bridge-reinstalled", limit: 5 });
  check("bridge-reinstalled visible when kind explicit", unfiltered.events.some((e) => e.kind === "bridge-reinstalled"), JSON.stringify(unfiltered.events.map((e) => e.kind)));

  console.log("\nTest 10: clean shutdown");
  ws.close();
  await client.close();
  check("client closed without error", true);

  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(2);
});
