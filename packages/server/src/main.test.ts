import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ORIGIN } from "@agentproxy/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type AgentProxy, startAgentProxy } from "./main.js";

const TOKEN = "test-token";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** An empty extension folder for the pairing, removed after the test. */
async function extensionFolder() {
  const dir = await mkdtemp(join(tmpdir(), "agentproxy-ext-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const readConfig = async (dir: string) =>
  JSON.parse(await readFile(join(dir, "config.json"), "utf8"));

/** Starts AgentProxy with a real bridge and an MCP client talking to it in-process. */
async function start({
  port = 0,
  token = TOKEN as string | null, // null: no forced token
  extensionDir = undefined as string | undefined,
} = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const proxy: AgentProxy = await startAgentProxy({
    port,
    token: token ?? undefined,
    extensionDir: extensionDir ?? (await extensionFolder()),
    version: "test",
    transport: serverTransport,
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientTransport);
  cleanups.push(() => proxy.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as Array<{ text: string }>;
    return JSON.parse(content?.text ?? "null");
  };
  return { proxy, call };
}

/** Connects a stand-in extension that confirms every rule list and can report matches. */
async function connectExtension(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: EXTENSION_ORIGIN });
  const rules: unknown[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(String(data));
    rules.push(message.rules);
    ws.send(JSON.stringify({ type: "applied", version: message.version }));
  });
  await new Promise((resolve) => ws.once("open", resolve));
  cleanups.push(async () => ws.close());
  return { ws, rules };
}

describe("startAgentProxy", () => {
  it("serves the tools and listens for the extension", async () => {
    const { proxy, call } = await start();
    expect("port" in proxy.listening).toBe(true);
    const status = await call("status");
    expect(status).toMatchObject({ extension_connected: false, active_mocks: 0 });
  });

  it("sends mocks to the extension and logs the matches it reports", async () => {
    const { proxy, call } = await start();
    const port = (proxy.listening as { port: number }).port;
    const extension = await connectExtension(port);
    await vi.waitFor(async () => expect((await call("status")).extension_connected).toBe(true));

    const set = await call("set_mock", { id: "orders", url: "*/api/orders", status: 500 });
    expect(set.applied).toBe(true);
    expect(extension.rules.at(-1)).toMatchObject([{ id: "orders" }]);

    const match = { ruleId: "orders", method: "GET", url: "http://x/api/orders", transport: "xhr" };
    extension.ws.send(JSON.stringify({ type: "match", match }));
    await vi.waitFor(async () =>
      expect((await call("get_matches")).matches).toMatchObject([{ mock_id: "orders" }]),
    );
  });

  it("still serves the tools when the port is taken, and says why", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => blocker.close(() => resolve())));
    const { port } = blocker.address() as AddressInfo;

    const { proxy, call } = await start({ port });
    expect(proxy.listening).toEqual({ error: expect.stringMatching(/already in use/) });
    const set = await call("set_mock", { url: "*/api/orders" });
    expect(set.applied).toBe(false);
    const status = await call("status");
    expect(status.note).toMatch(new RegExp(`port ${port} is already in use`));
  });

  describe("pairing", () => {
    it("writes the actual port and the token into the extension folder", async () => {
      const dir = await extensionFolder();
      const { proxy, call } = await start({ extensionDir: dir });
      const { port } = proxy.listening as { port: number };
      expect(await readConfig(dir)).toEqual({ port, token: TOKEN });
      expect(proxy.pairing).toEqual({ extensionDir: dir });
      expect((await call("status")).extension_dir).toBe(dir);
    });

    it("reuses the paired token when none is forced, so restarts keep the pairing", async () => {
      const dir = await extensionFolder();
      await writeFile(join(dir, "config.json"), '{"port":1234,"token":"kept"}');
      const { proxy } = await start({ extensionDir: dir, token: null });
      expect(await readConfig(dir)).toEqual({
        port: (proxy.listening as { port: number }).port,
        token: "kept",
      });
    });

    it("makes up a token when there is no pairing yet", async () => {
      const dir = await extensionFolder();
      await start({ extensionDir: dir, token: null });
      expect((await readConfig(dir)).token).toMatch(/^[0-9a-f]{32}$/);
    });

    it("lets a forced token replace the paired one", async () => {
      const dir = await extensionFolder();
      await writeFile(join(dir, "config.json"), '{"port":1234,"token":"old"}');
      await start({ extensionDir: dir, token: "forced" });
      expect((await readConfig(dir)).token).toBe("forced");
    });

    it("still runs when the folder is missing, and status says why", async () => {
      const missing = join(await extensionFolder(), "not-built");
      const { proxy, call } = await start({ extensionDir: missing });
      expect(proxy.pairing).toEqual({ error: `${missing} doesn't exist` });
      const status = await call("status");
      expect(status.pairing_error).toBe(`${missing} doesn't exist`);
      expect(status.note).toMatch(/can't be paired.*pnpm build/);
    });
  });
});
