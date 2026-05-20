import { z } from "zod";
import { eventBus } from "../events.js";
import type { BridgeEvent } from "../types.js";

export const runtimeErrorsInput = {
  limit: z.number().int().min(1).max(50).optional().describe("Max errors to return (1-50, default 10)."),
  sinceTs: z.number().int().optional().describe("Only return errors with ts >= sinceTs (epoch ms)."),
};

interface ErrorPayload {
  message?: string;
  stack?: string;
  file?: string;
  line?: number;
  column?: number;
}

export function getRuntimeErrors(args: { limit?: number; sinceTs?: number }) {
  const limit = args.limit ?? 10;
  const sinceTs = args.sinceTs ?? 0;

  const all = eventBus.getAll();
  const errors = all
    .filter((e) => e.kind === "runtime-error" || e.kind === "unhandled-rejection")
    .filter((e) => e.ts >= sinceTs)
    .slice(-limit)
    .map((e: BridgeEvent) => {
      const data = (e.data ?? {}) as ErrorPayload;
      return {
        ts: e.ts,
        id: e.id,
        kind: e.kind,
        message: data.message ?? e.message,
        stack: data.stack,
        file: data.file,
        line: data.line,
        column: data.column,
      };
    });

  return { errors, count: errors.length };
}
