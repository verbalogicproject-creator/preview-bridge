import { z } from "zod";
import { eventBus } from "../events.js";
import type { BridgeKind } from "../types.js";

const KIND_ENUM = z.enum([
  "session-connected",
  "session-disconnected",
  "runtime-error",
  "unhandled-rejection",
  "iframe-click",
  "iframe-form-change",
  "iframe-console",
  "iframe-route-change",
  "bridge-reinstalled",
]);

export const tailEventsInput = {
  kinds: z.array(KIND_ENUM).min(1).describe("Event kinds to wait for (matches any in the list)."),
  maxWaitMs: z
    .number()
    .int()
    .min(1)
    .max(30000)
    .optional()
    .describe("Max wait in ms (default 5000, max 30000)."),
  limit: z.number().int().min(1).max(50).optional().describe("Max events to return (default 20)."),
};

export async function tailEvents(args: {
  kinds: BridgeKind[];
  maxWaitMs?: number;
  limit?: number;
}) {
  const result = await eventBus.tail(args.kinds, args.maxWaitMs ?? 5000, args.limit ?? 20);
  return result;
}
