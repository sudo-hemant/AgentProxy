import { type ExtensionToServer, type MockRule, PROTOCOL_VERSION } from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerConnection, type SocketLike } from "./connection.js";

const rule = (id: string): MockRule => ({
  id,
  match: { url: { kind: "wildcard", value: "*/api/orders" } },
  response: { status: 500 },
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/** A fake WebSocket the test opens, closes and talks through. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ExtensionToServer[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.serverCloses();
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  serverSays(message: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  serverCloses(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

function setup(applyRules = vi.fn(async (_rules: MockRule[]) => {})) {
  const sockets: FakeSocket[] = [];
  const connection = createServerConnection({
    config: { port: 4000, token: "t o/k" },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    applyRules,
    reconnectDelayMs: 1000,
    pingIntervalMs: 20_000,
  });
  return { connection, sockets, applyRules, latest: () => sockets.at(-1) as FakeSocket };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createServerConnection", () => {
  it("connects to the server's port on loopback with the encoded token", () => {
    const { connection, latest } = setup();
    connection.start();
    expect(latest().url).toBe("ws://127.0.0.1:4000/?token=t%20o%2Fk");
  });

  it("says hello with the protocol version once open", () => {
    const { connection, latest } = setup();
    connection.start();
    latest().open();
    expect(latest().sent).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION }]);
  });

  it("doesn't open a second socket while connecting or connected", () => {
    const { connection, sockets } = setup();
    connection.start();
    connection.start();
    sockets[0]?.open();
    connection.start();
    expect(sockets).toHaveLength(1);
  });

  describe("rules", () => {
    it("applies each rule list, then confirms its version", async () => {
      const { connection, latest, applyRules } = setup();
      connection.start();
      latest().open();
      latest().serverSays({ type: "rules", version: 3, rules: [rule("a")] });
      await vi.waitFor(() => expect(latest().sent).toContainEqual({ type: "applied", version: 3 }));
      expect(applyRules).toHaveBeenCalledWith([rule("a")]);
    });

    it("confirms in the order the lists arrived, even if one takes longer", async () => {
      let finishFirst!: () => void;
      const applyRules = vi
        .fn<(rules: MockRule[]) => Promise<void>>()
        .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
        .mockImplementation(async () => {});
      const { connection, latest } = setup(applyRules);
      connection.start();
      latest().open();
      latest().serverSays({ type: "rules", version: 1, rules: [] });
      latest().serverSays({ type: "rules", version: 2, rules: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(latest().sent.filter((m) => m.type === "applied")).toEqual([]);
      finishFirst();
      await vi.waitFor(() =>
        expect(latest().sent.filter((m) => m.type === "applied")).toEqual([
          { type: "applied", version: 1 },
          { type: "applied", version: 2 },
        ]),
      );
    });

    it("doesn't confirm a list it failed to apply, and keeps going", async () => {
      const applyRules = vi
        .fn<(rules: MockRule[]) => Promise<void>>()
        .mockRejectedValueOnce(new Error("storage full"))
        .mockResolvedValue(undefined);
      const { connection, latest } = setup(applyRules);
      connection.start();
      latest().open();
      latest().serverSays({ type: "rules", version: 1, rules: [] });
      latest().serverSays({ type: "rules", version: 2, rules: [] });
      await vi.waitFor(() =>
        expect(latest().sent.filter((m) => m.type === "applied")).toEqual([
          { type: "applied", version: 2 },
        ]),
      );
    });

    it("ignores messages that aren't valid", async () => {
      const { connection, latest, applyRules } = setup();
      connection.start();
      latest().open();
      latest().serverSays({ type: "rules", version: "3", rules: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(applyRules).not.toHaveBeenCalled();
    });
  });

  describe("match reports", () => {
    const match = { ruleId: "a", method: "GET", url: "http://x/", transport: "fetch" } as const;

    it("are sent while connected", () => {
      const { connection, latest } = setup();
      connection.start();
      latest().open();
      connection.sendMatch(match);
      expect(latest().sent).toContainEqual({ type: "match", match });
    });

    it("are dropped while not connected", () => {
      const { connection, latest } = setup();
      connection.start();
      connection.sendMatch(match); // still connecting
      latest().open();
      expect(latest().sent).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION }]);
    });
  });

  describe("keepalive", () => {
    it("pings every interval while open, and stops once closed", () => {
      const { connection, latest } = setup();
      connection.start();
      latest().open();
      vi.advanceTimersByTime(40_000);
      const socket = latest();
      expect(socket.sent.filter((m) => m.type === "ping")).toHaveLength(2);
      socket.serverCloses();
      vi.advanceTimersByTime(40_000);
      expect(socket.sent.filter((m) => m.type === "ping")).toHaveLength(2);
    });
  });

  describe("reconnecting", () => {
    it("reconnects after the delay when the connection drops", () => {
      const { connection, sockets, latest } = setup();
      connection.start();
      latest().open();
      latest().serverCloses();
      vi.advanceTimersByTime(999);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
    });

    it("keeps trying while the server is down", () => {
      const { connection, sockets, latest } = setup();
      connection.start();
      for (let i = 0; i < 3; i++) {
        latest().serverCloses(); // refused before opening
        vi.advanceTimersByTime(1000);
      }
      expect(sockets).toHaveLength(4);
    });

    it("waits for the next start after a protocol mismatch", () => {
      const { connection, sockets, latest } = setup();
      connection.start();
      latest().open();
      latest().serverCloses(4000);
      vi.advanceTimersByTime(10_000);
      expect(sockets).toHaveLength(1);
      connection.start();
      expect(sockets).toHaveLength(2);
    });

    it("doesn't connect twice when start is called while a reconnect is pending", () => {
      const { connection, sockets, latest } = setup();
      connection.start();
      latest().serverCloses();
      connection.start();
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
    });
  });
});
