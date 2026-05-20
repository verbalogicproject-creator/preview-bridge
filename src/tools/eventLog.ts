import { z } from "zod";
import { eventBus } from "../events.js";

export const eventLogInput = {
  source: z.enum(["iframe", "host", "bridge"]).optional().describe("Filter by source."),
  level: z.enum(["debug", "info", "warn", "error", "system"]).optional().describe("Filter by severity."),
  kind: z
    .enum([
      "session-connected",
      "session-disconnected",
      "runtime-error",
      "unhandled-rejection",
      "iframe-click",
      "iframe-form-change",
      "iframe-console",
      "iframe-route-change",
      "bridge-reinstalled",
    ])
    .optional()
    .describe("Filter by event kind."),
  since: z.string().optional().describe("Return events after this event id (cursor pagination)."),
  limit: z.number().int().min(1).max(200).optional().describe("Max events to return (1-200, default 50)."),
};

export function getEventLog(args: {
  source?: "iframe" | "host" | "bridge";
  level?: "debug" | "info" | "warn" | "error" | "system";
  kind?:
    | "session-connected"
    | "session-disconnected"
    | "runtime-error"
    | "unhandled-rejection"
    | "iframe-click"
    | "iframe-form-change"
    | "iframe-console"
    | "iframe-route-change"
    | "bridge-reinstalled";
  since?: string;
  limit?: number;
}) {
  // Default-filter out bridge-reinstalled noise unless explicitly requested
  const result = eventBus.getRecent(args);
  if (!args.kind) {
    result.events = result.events.filter((e) => e.kind !== "bridge-reinstalled");
  }
  return result;
}
