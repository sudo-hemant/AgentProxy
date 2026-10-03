import {
  type ExtensionConfig,
  type ExtensionToServer,
  type MockRule,
  PROTOCOL_VERSION,
} from "@agentproxy/shared";
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
  let config: ExtensionConfig | undefined = { port: 4000, token: "t o/k" };
  const loadConfig = vi.fn(async () => config);
  const connection = createServerConnection({
    loadConfig,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    applyRules,
    reconnectDelayMs: 1000,
    pingIntervalMs: 20_000,
  });
  return {
    connection,
    sockets,
    applyRules,
    loadConfig,
    setConfig: (next: ExtensionConfig | undefined) => (config = next),
    latest: () => sockets.at(-1) as FakeSocket,
    /** Starts connecting and lets the config be read. */
    start: async () => {
      connection.start();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createServerConnection", () => {
  it("connects to the server's port on loopback with the encoded token", async () => {
    const { start, latest } = setup();
    await start();
    expect(latest().url).toBe("ws://127.0.0.1:4000/?token=t%20o%2Fk");
  });

  it("says hello with the protocol version once open", async () => {
    const { start, latest } = setup();
    await start();
    latest().open();
    expect(latest().sent).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION }]);
  });

  it("doesn't open a second socket while connecting or connected", async () => {
    const { start, sockets } = setup();
    await start();
    await start();
    sockets[0]?.open();
    await start();
    expect(sockets).toHaveLength(1);
  });

  describe("rules", () => {
    it("applies each rule list, then confirms its version", async () => {
      const { start, latest, applyRules } = setup();
      await start();
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
      const { start, latest } = setup(applyRules);
      await start();
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
      const { start, latest } = setup(applyRules);
      await start();
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
      const { start, latest, applyRules } = setup();
      await start();
      latest().open();
      latest().serverSays({ type: "rules", version: "3", rules: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(applyRules).not.toHaveBeenCalled();
    });
  });

  describe("match reports", () => {
    const match = { ruleId: "a", method: "GET", url: "http://x/", transport: "fetch" } as const;

    it("are sent while connected", async () => {
      const { connection, start, latest } = setup();
      await start();
      latest().open();
      connection.sendMatch(match);
      expect(latest().sent).toContainEqual({ type: "match", match });
    });

    it("are dropped while not connected", async () => {
      const { connection, start, latest } = setup();
      await start();
      connection.sendMatch(match); // still connecting
      latest().open();
      expect(latest().sent).toEqual([{ type: "hello", protocolVersion: PROTOCOL_VERSION }]);
    });
  });

  describe("keepalive", () => {
    it("pings every interval while open, and stops once closed", async () => {
      const { start, latest } = setup();
      await start();
      latest().open();
      await vi.advanceTimersByTimeAsync(40_000);
      const socket = latest();
      expect(socket.sent.filter((m) => m.type === "ping")).toHaveLength(2);
      socket.serverCloses();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(socket.sent.filter((m) => m.type === "ping")).toHaveLength(2);
    });
  });

  describe("reconnecting", () => {
    it("reconnects after the delay when the connection drops", async () => {
      const { start, sockets, latest } = setup();
      await start();
      latest().open();
      latest().serverCloses();
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
    });

    it("keeps trying while the server is down", async () => {
      const { start, sockets, latest } = setup();
      await start();
      for (let i = 0; i < 3; i++) {
        latest().serverCloses(); // refused before opening
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(sockets).toHaveLength(4);
    });

    it("waits for the next start after a protocol mismatch", async () => {
      const { start, sockets, latest } = setup();
      await start();
      latest().open();
      latest().serverCloses(4000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets).toHaveLength(1);
      await start();
      expect(sockets).toHaveLength(2);
    });

    it("doesn't connect twice when start is called while a reconnect is pending", async () => {
      const { start, sockets, latest } = setup();
      await start();
      latest().serverCloses();
      await start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
    });
  });

  describe("config", () => {
    it("reads it again before each attempt, so a new port is picked up", async () => {
      const { start, latest, setConfig } = setup();
      await start();
      latest().open();
      setConfig({ port: 5000, token: "new" });
      latest().serverCloses();
      await vi.advanceTimersByTimeAsync(1000);
      expect(latest().url).toBe("ws://127.0.0.1:5000/?token=new");
    });

    it("keeps looking until one appears", async () => {
      const { start, sockets, setConfig } = setup();
      setConfig(undefined);
      await start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(sockets).toEqual([]);
      setConfig({ port: 4000, token: "t" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(1);
    });

    it("keeps looking when reading it fails", async () => {
      const { start, sockets, loadConfig } = setup();
      loadConfig.mockRejectedValueOnce(new Error("Failed to fetch"));
      await start();
      expect(sockets).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(1);
    });

    it("opens one socket when start is called again while it is being read", async () => {
      const { connection, sockets, loadConfig } = setup();
      connection.start();
      connection.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(sockets).toHaveLength(1);
    });
  });
});
