import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Bridge, startBridge } from "./bridge.js";

const TOKEN = "test-token";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let bridge: Bridge;

beforeEach(async () => {
  bridge = await startBridge({ port: 0, token: TOKEN, extensionOrigin: EXTENSION_ORIGIN });
});

afterEach(async () => {
  await bridge.close();
});

/** Tries to connect; resolves "open", or the HTTP status the server refused with. */
function tryConnect({
  origin = EXTENSION_ORIGIN,
  token = TOKEN as string | null,
  host = `127.0.0.1:${bridge.port}`,
} = {}): Promise<"open" | number> {
  const query = token === null ? "" : `?token=${token}`;
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/${query}`, {
    origin,
    headers: { host },
  });
  return new Promise((resolve) => {
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => {}); // reported through unexpected-response
  });
}

describe("startBridge", () => {
  it("accepts our extension with the token", async () => {
    expect(await tryConnect()).toBe("open");
  });

  it("accepts localhost as the Host too", async () => {
    expect(await tryConnect({ host: `localhost:${bridge.port}` })).toBe("open");
  });

  describe("refuses with 403", () => {
    it("a website, even with the right token", async () => {
      expect(await tryConnect({ origin: "http://localhost:3000" })).toBe(403);
    });

    it("another extension", async () => {
      expect(await tryConnect({ origin: "chrome-extension://someoneelse" })).toBe(403);
    });

    it("a wrong or missing token", async () => {
      expect(await tryConnect({ token: "wrong" })).toBe(403);
      expect(await tryConnect({ token: "test-token-but-longer" })).toBe(403);
      expect(await tryConnect({ token: null })).toBe(403);
    });

    it("a Host other than this port on loopback (DNS rebinding)", async () => {
      expect(await tryConnect({ host: `evil.example:${bridge.port}` })).toBe(403);
      expect(await tryConnect({ host: "127.0.0.1:1" })).toBe(403);
    });
  });

  it("syncs rules with a connected extension", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=${TOKEN}`, {
      origin: EXTENSION_ORIGIN,
    });
    const received: unknown[] = [];
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      ws.send(JSON.stringify({ type: "applied", version: message.version }));
    });
    await new Promise((resolve) => ws.once("message", resolve)); // the rules sent on connect

    const result = await bridge.setRules([]);
    expect(result).toEqual({ version: 1, applied: true });
    expect(received).toEqual([
      { type: "rules", version: 0, rules: [] },
      { type: "rules", version: 1, rules: [] },
    ]);
    ws.close();
  });

  it("answers plain HTTP requests with 404", async () => {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/`);
    expect(response.status).toBe(404);
  });

  it("fails to start when the port is taken", async () => {
    await expect(
      startBridge({ port: bridge.port, token: TOKEN, extensionOrigin: EXTENSION_ORIGIN }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
