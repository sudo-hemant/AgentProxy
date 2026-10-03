import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { MatchReport, MockRule } from "@agentproxy/shared";
import { WebSocketServer } from "ws";
import { createConnectionTracker } from "./extension-connection.js";
import { createRuleSync, type SetRulesResult } from "./rule-sync.js";

export interface BridgeOptions {
  /** Port on 127.0.0.1. 0 picks a free one (tests). */
  port: number;
  /** The pairing token the extension must present. */
  token: string;
  /** The only Origin allowed to connect: `chrome-extension://<our extension id>`. */
  extensionOrigin: string;
  /** How long `setRules` waits for the extension to confirm. */
  ackTimeoutMs?: number;
  /** Drop an extension connection that sends nothing for this long. */
  silenceTimeoutMs?: number;
  /** Called for every request the extension answered with a mock. */
  onMatch?: (match: MatchReport) => void;
}

export interface Bridge {
  /** The port actually listened on. */
  port: number;
  /** Replaces the rules, sends them to the extension, and waits for it to confirm them. */
  setRules(rules: MockRule[]): Promise<SetRulesResult>;
  getRules(): MockRule[];
  /** Whether the extension is connected right now. */
  isConnected(): boolean;
  close(): Promise<void>;
}

/**
 * The local WebSocket endpoint the extension connects to. Listens on 127.0.0.1 only, and
 * accepts a connection only from our extension, with the pairing token, addressed to this port.
 */
export function startBridge(options: BridgeOptions): Promise<Bridge> {
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sync = createRuleSync({ ackTimeoutMs: options.ackTimeoutMs });
  const tracker = createConnectionTracker({
    silenceTimeoutMs: options.silenceTimeoutMs,
    onMatch: options.onMatch,
  });
  wss.on("connection", (ws) => {
    tracker.accept(ws);
    sync.attach(ws);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;

      server.on("upgrade", (req, socket, head) => {
        if (!isAllowed(req, options, port)) return refuse(socket);
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });

      resolve({
        port,
        setRules: sync.setRules,
        getRules: sync.getRules,
        isConnected: tracker.isConnected,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Any website can try to open ws://127.0.0.1, and the browser applies no CORS to WebSockets.
 * The browser stamps the real Origin, which a page can't fake; the token keeps out other local
 * programs; the Host check blocks DNS rebinding (an attacker's domain resolving to 127.0.0.1).
 */
function isAllowed(req: IncomingMessage, options: BridgeOptions, port: number): boolean {
  if (req.headers.origin !== options.extensionOrigin) return false;
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const token = new URL(req.url ?? "/", "http://placeholder").searchParams.get("token");
  return token !== null && sameSecret(token, options.token);
}

/** Compares in constant time, so the token can't be guessed from response timing. */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function refuse(socket: Duplex): void {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
