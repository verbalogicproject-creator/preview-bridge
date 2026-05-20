export type BridgeSource = "iframe" | "host" | "bridge";

export type BridgeLevel = "debug" | "info" | "warn" | "error" | "system";

export type BridgeKind =
  | "session-connected"
  | "session-disconnected"
  | "runtime-error"
  | "unhandled-rejection"
  | "iframe-click"
  | "iframe-form-change"
  | "iframe-console"
  | "iframe-route-change"
  | "bridge-reinstalled";

export interface BridgeEvent {
  id: string;
  ts: number;
  source: BridgeSource;
  level: BridgeLevel;
  kind: BridgeKind;
  component: string;
  message: string;
  data?: unknown;
}

export interface EventFilter {
  source?: BridgeSource;
  level?: BridgeLevel;
  kind?: BridgeKind;
  since?: string;
  limit?: number;
}

export type StateKind = "form" | "route" | "selection" | "focus" | "all";

export interface PreviewStateSnapshot {
  kind: StateKind;
  snapshot: unknown;
  capturedAt: number;
}

export interface SessionInfo {
  connectedAt: number | null;
  mode: "hosted-iframe" | "top-level" | "unknown" | "disconnected";
  previewUrl: string | null;
  bridgeVersion: string;
  eventCount: number;
  connectionsOpen: number;
}
