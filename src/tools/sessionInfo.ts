import { eventBus } from "../events.js";
import { relay } from "../relay.js";
import type { SessionInfo } from "../types.js";

export const BRIDGE_VERSION = "0.1.0";

export function getSessionInfo(): SessionInfo {
  const meta = relay.latestClientMeta;
  return {
    connectedAt: meta?.connectedAt ?? null,
    mode: meta?.mode ?? "disconnected",
    previewUrl: meta?.previewUrl ?? null,
    bridgeVersion: BRIDGE_VERSION,
    eventCount: eventBus.entryCount,
    connectionsOpen: relay.connectionsOpen,
  };
}
