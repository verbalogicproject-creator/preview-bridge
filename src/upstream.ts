/*
 * HTTP client for an ALREADY-RUNNING preview-bridge (the "leader").
 *
 * WHY THIS EXISTS. Claude Code spawns one stdio MCP child per session, but this
 * server binds two fixed ports. The second session's child therefore hit
 * EADDRINUSE and called process.exit(1), which the client reports only as
 * "Connection closed" -- an unhelpful message for a completely deterministic
 * failure that persists for as long as the first session lives.
 *
 * Sharing is also the semantically correct answer, not just the convenient one:
 * there is ONE browser page being observed, so every session should see the same
 * event stream. Two relays on two ports would mean two half-views of one page.
 */
import { BRIDGE_VERSION } from "./tools/sessionInfo.js";

const HTTP_PORT = Number(process.env.PREVIEW_BRIDGE_HTTP_PORT ?? 5250);
export const UPSTREAM_BASE = `http://127.0.0.1:${HTTP_PORT}`;

export interface UpstreamIdentity {
  service: string;
  version: string;
  pid: number | null;
}

/**
 * Confirm that whatever holds our HTTP port is actually a preview-bridge.
 *
 * Proxying blind would be worse than failing: another project's dev server on
 * 5250 would answer 200 to /health and we would forward the user's questions to
 * it. So identity is REQUIRED. `connections`-only replies are accepted as a
 * legacy signature, because a leader built before this change cannot know to
 * send `service` and refusing it would strand the user until every session
 * restarts.
 */
export async function probeUpstream(timeoutMs = 1500): Promise<UpstreamIdentity | null> {
  try {
    const res = await fetch(`${UPSTREAM_BASE}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (body.ok !== true) return null;
    if (body.service === "preview-bridge") {
      return {
        service: "preview-bridge",
        version: typeof body.version === "string" ? body.version : "unknown",
        pid: typeof body.pid === "number" ? body.pid : null,
      };
    }
    // Legacy leader: {ok:true, connections:<number>} and nothing else.
    if (typeof body.connections === "number") {
      return { service: "preview-bridge", version: "legacy", pid: null };
    }
    return null;
  } catch {
    return null;
  }
}

export class UpstreamError extends Error {}

/** GET a JSON endpoint on the leader. Throws UpstreamError; never returns junk. */
export async function upstreamGet(
  path: string,
  params: Record<string, string | number | undefined> = {},
  timeoutMs = 5000,
): Promise<unknown> {
  const url = new URL(path, UPSTREAM_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UpstreamError(
      `cannot reach the preview-bridge leader at ${UPSTREAM_BASE}: ` +
        (err instanceof Error ? err.message : "unknown error"),
    );
  }
  if (!res.ok) {
    throw new UpstreamError(`leader returned HTTP ${res.status} for ${url.pathname}`);
  }
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(`leader returned non-JSON for ${url.pathname}`);
  }
}

/**
 * A follower's answer when the leader is gone. Shaped as data rather than an
 * exception so the MCP tool still replies -- a tool that throws tells the model
 * nothing about WHY, and "the bridge moved" is exactly the thing worth saying.
 */
export function upstreamFailure(err: unknown): Record<string, unknown> {
  return {
    ok: false,
    error: err instanceof Error ? err.message : "unknown upstream error",
    role: "follower",
    bridgeVersion: BRIDGE_VERSION,
    hint:
      "This session is a follower of another preview-bridge instance that has " +
      "stopped answering. It will promote itself to leader within a few seconds; " +
      "retry the call.",
  };
}
