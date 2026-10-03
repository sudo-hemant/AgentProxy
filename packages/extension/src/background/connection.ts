import {
  CLOSE_PROTOCOL_MISMATCH,
  type ExtensionConfig,
  type ExtensionToServer,
  type MatchReport,
  type MockRule,
  PROTOCOL_VERSION,
  parseServerToExtension,
} from "@agentproxy/shared";

/** The part of a browser WebSocket the connection uses, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

export interface ServerConnectionOptions {
  config: ExtensionConfig;
  createSocket(url: string): SocketLike;
  /** Stores a rule list the server sent; the connection confirms it once this resolves. */
  applyRules(rules: MockRule[]): Promise<void>;
  reconnectDelayMs?: number;
  pingIntervalMs?: number;
}

export interface ServerConnection {
  /** Connects, unless already connected or connecting. Safe to call often. */
  start(): void;
  /** Tells the server a request was answered by a mock. Dropped while disconnected. */
  sendMatch(match: MatchReport): void;
}

export const DEFAULT_RECONNECT_DELAY_MS = 1000;
/** Chrome stops an idle service worker after 30 s; WebSocket traffic counts as activity. */
export const DEFAULT_PING_INTERVAL_MS = 20_000;
const OPEN = 1;
const CONNECTING = 0;

export function createServerConnection({
  config,
  createSocket,
  applyRules,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
}: ServerConnectionOptions): ServerConnection {
  const url = `ws://127.0.0.1:${config.port}/?token=${encodeURIComponent(config.token)}`;
  let socket: SocketLike | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Rule lists are applied one after another, so confirmations go out in the order sent.
  let applying = Promise.resolve();

  const send = (message: ExtensionToServer) => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
  };

  const connect = () => {
    if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) return;
    clearTimeout(reconnectTimer);
    const current = createSocket(url);
    socket = current;

    current.onopen = () => {
      send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
      pingTimer = setInterval(() => send({ type: "ping" }), pingIntervalMs);
    };
    current.onmessage = (event) => {
      const message = parseServerToExtension(String(event.data));
      if (message?.type !== "rules") return;
      applying = applying
        .then(() => applyRules(message.rules))
        .then(() => send({ type: "applied", version: message.version }))
        .catch(() => {}); // not confirmed: the server reports the change as unapplied
    };
    current.onclose = (event) => {
      clearInterval(pingTimer);
      if (socket !== current) return;
      socket = undefined;
      // A version mismatch won't fix itself in a second: wait for the next start() instead.
      if (event.code === CLOSE_PROTOCOL_MISMATCH) return;
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    };
  };

  return {
    start: connect,
    sendMatch: (match) => send({ type: "match", match }),
  };
}
