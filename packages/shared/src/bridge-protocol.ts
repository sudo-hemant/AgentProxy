import type { MatchReport } from "./messages.js";
import type { MockRule } from "./rule.js";

// Messages on the WebSocket between the server and the extension's background. Each message is
// one JSON object. Both sides check what they receive, since it crosses a process boundary.

/** Close code the server uses when the extension speaks another protocol version. */
export const CLOSE_PROTOCOL_MISMATCH = 4000;

/** Server → extension. */
export type ServerToExtension =
  /** The full rule list. `version` grows with every change, so the extension can confirm it. */
  { type: "rules"; version: number; rules: MockRule[] };

/** Extension → server. */
export type ExtensionToServer =
  /** Sent first on every connection. */
  | { type: "hello"; protocolVersion: number }
  /** The rules with this version are stored and on their way to open pages. */
  | { type: "applied"; version: number }
  /** A request was answered by a mock. */
  | { type: "match"; match: MatchReport }
  /** Keepalive, so Chrome keeps the service worker running and the server knows it's there. */
  | { type: "ping" };

/** Parses a message from the server, or returns undefined if it isn't one. */
export function parseServerToExtension(raw: string): ServerToExtension | undefined {
  const data = parseObject(raw);
  if (data?.type === "rules" && isVersion(data.version) && Array.isArray(data.rules)) {
    return { type: "rules", version: data.version, rules: data.rules as MockRule[] };
  }
  return undefined;
}

/** Parses a message from the extension, or returns undefined if it isn't one. */
export function parseExtensionToServer(raw: string): ExtensionToServer | undefined {
  const data = parseObject(raw);
  switch (data?.type) {
    case "hello":
      return isVersion(data.protocolVersion)
        ? { type: "hello", protocolVersion: data.protocolVersion }
        : undefined;
    case "applied":
      return isVersion(data.version) ? { type: "applied", version: data.version } : undefined;
    case "match":
      return isMatchReport(data.match) ? { type: "match", match: data.match } : undefined;
    case "ping":
      return { type: "ping" };
    default:
      return undefined;
  }
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const data: unknown = JSON.parse(raw);
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isMatchReport(value: unknown): value is MatchReport {
  if (typeof value !== "object" || value === null) return false;
  const { ruleId, method, url, transport } = value as Record<string, unknown>;
  return (
    typeof ruleId === "string" &&
    typeof method === "string" &&
    typeof url === "string" &&
    (transport === "fetch" || transport === "xhr")
  );
}
