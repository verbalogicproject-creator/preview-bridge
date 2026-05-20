import { z } from "zod";
import { relay } from "../relay.js";

export const previewStateInput = {
  kind: z
    .enum(["form", "route", "selection", "focus", "all"])
    .describe("Which slice of preview state to query."),
  selector: z.string().optional().describe("Optional CSS selector to scope the query."),
};

export async function queryPreviewState(args: {
  kind: "form" | "route" | "selection" | "focus" | "all";
  selector?: string;
}) {
  try {
    const snapshot = await relay.requestState(args.kind, 800);
    return {
      ok: true,
      kind: args.kind,
      snapshot,
      capturedAt: Date.now(),
    };
  } catch (err) {
    return {
      ok: false,
      kind: args.kind,
      error: err instanceof Error ? err.message : "unknown error",
      hint:
        relay.connectionsOpen === 0
          ? "No host page connected. Open http://localhost:" +
            (process.env.PREVIEW_BRIDGE_HTTP_PORT ?? "5250") +
            "/?app=<your-app-url> or include <script src='http://localhost:" +
            (process.env.PREVIEW_BRIDGE_HTTP_PORT ?? "5250") +
            "/__bridge.js'> in your page."
          : "Host connected but state-snapshot timed out. Check that __bridge.js is loaded in the page.",
    };
  }
}
