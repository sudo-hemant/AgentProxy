import { type MatchReport, PROTOCOL_VERSION, parseExtensionToServer } from "@agentproxy/shared";
import type { ExtensionSocket } from "./rule-sync.js";

/** What the connection tracker needs from a `ws` WebSocket, beyond what the rule sync uses. */
export interface TrackedSocket extends ExtensionSocket {
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface ConnectionTrackerOptions {
  /** Drop a connection that sends nothing for this long. The extension pings every 20 s. */
  silenceTimeoutMs?: number;
  onMatch?: (match: MatchReport) => void;
}

export interface ConnectionTracker {
  /** Tracks a newly connected extension, replacing the one before it. */
  accept(socket: TrackedSocket): void;
  isConnected(): boolean;
}

export const DEFAULT_SILENCE_TIMEOUT_MS = 60_000;
/** Close code sent when the extension speaks another protocol version. */
export const CLOSE_PROTOCOL_MISMATCH = 4000;

export function createConnectionTracker({
  silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
  onMatch,
}: ConnectionTrackerOptions = {}): ConnectionTracker {
  let current: TrackedSocket | undefined;

  return {
    accept(socket) {
      // One browser, one extension: a new connection means the old one is stale, for example
      // after the extension was reloaded.
      current?.close(1000, "replaced by a newer connection");
      current = socket;

      let silenceTimer: NodeJS.Timeout | undefined;
      const resetSilenceTimer = () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => socket.terminate(), silenceTimeoutMs);
      };
      resetSilenceTimer();

      socket.on("message", (data) => {
        resetSilenceTimer();
        const message = parseExtensionToServer(String(data));
        if (message?.type === "hello" && message.protocolVersion !== PROTOCOL_VERSION) {
          socket.close(CLOSE_PROTOCOL_MISMATCH, `server speaks protocol v${PROTOCOL_VERSION}`);
        }
        if (message?.type === "match") onMatch?.(message.match);
      });
      socket.on("close", () => {
        clearTimeout(silenceTimer);
        if (current === socket) current = undefined;
      });
    },

    isConnected: () => current !== undefined,
  };
}
