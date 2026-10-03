import type { MockRule } from "@agentproxy/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMatchLog } from "./match-log.js";
import { type BrowserLink, createMcpServer, type Listening } from "./mcp.js";
import { createMockStore } from "./mock-store.js";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

/** A browser stand-in that records each rule list it is sent. */
function fakeBrowser({ connected = true, applied = true } = {}) {
  const sent: MockRule[][] = [];
  const browser: BrowserLink = {
    setRules: async (rules) => {
      sent.push(rules);
      return { version: sent.length, applied };
    },
    isConnected: () => connected,
  };
  return { browser, sent };
}

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** A real MCP client talking to the server in-process. */
async function connect(browser = fakeBrowser().browser, listening: Listening = { port: 47821 }) {
  let ids = 0;
  let time = NOW;
  const now = () => time;
  const matches = createMatchLog({ now });
  const server = createMcpServer({
    browser,
    listening,
    store: createMockStore({ now }),
    matches,
    version: "test",
    now,
    newId: () => `mock-${++ids}`,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  clients.push(client);

  /** Calls a tool and parses its JSON reply. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError === true, data: JSON.parse(content?.text ?? "null") };
  };
  return { client, call, matches, setTime: (t: number) => (time = t) };
}

describe("MCP server", () => {
  it("offers its tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "set_mock",
      "list_mocks",
      "clear_mocks",
      "get_matches",
      "status",
    ]);
    const setMock = tools.find((t) => t.name === "set_mock");
    expect(setMock?.inputSchema.required).toEqual(["url"]);
  });

  describe("set_mock", () => {
    it("stores the mock, sends it to the browser, and reports it applied", async () => {
      const { browser, sent } = fakeBrowser();
      const { call } = await connect(browser);
      const { isError, data } = await call("set_mock", {
        url: "*/api/orders",
        status: 500,
        expires_in_seconds: 60,
      });
      expect(isError).toBe(false);
      expect(data).toEqual({
        id: "mock-1",
        replaced: false,
        expires_at: new Date(NOW + 60_000).toISOString(),
        applied: true,
        note: "Active in the browser. It applies to new requests: reload the page if needed.",
      });
      expect(sent).toEqual([
        [
          {
            id: "mock-1",
            match: { url: { kind: "wildcard", value: "*/api/orders" } },
            response: { status: 500 },
            expiresAt: NOW + 60_000,
          },
        ],
      ]);
    });

    it("sends the browser every live mock, not just the new one", async () => {
      const { browser, sent } = fakeBrowser();
      const { call } = await connect(browser);
      await call("set_mock", { url: "*/a" });
      await call("set_mock", { url: "*/b" });
      expect(sent.at(-1)?.map((r) => r.id)).toEqual(["mock-1", "mock-2"]);
    });

    it("replaces a mock set with the same id", async () => {
      const { browser, sent } = fakeBrowser();
      const { call } = await connect(browser);
      await call("set_mock", { id: "orders", url: "*/orders", status: 500 });
      const { data } = await call("set_mock", { id: "orders", url: "*/orders", status: 404 });
      expect(data.replaced).toBe(true);
      expect(sent.at(-1)?.map((r) => r.response.status)).toEqual([404]);
    });

    it("says to open Chrome when no browser is connected, and keeps the mock", async () => {
      const { call } = await connect(fakeBrowser({ connected: false, applied: false }).browser);
      const { isError, data } = await call("set_mock", { url: "*/orders" });
      expect(isError).toBe(false);
      expect(data.applied).toBe(false);
      expect(data.note).toMatch(/No browser is connected/);
      expect((await call("list_mocks")).data.mocks).toHaveLength(1);
    });

    it("says when a connected browser didn't confirm in time", async () => {
      const { call } = await connect(fakeBrowser({ connected: true, applied: false }).browser);
      const { data } = await call("set_mock", { url: "*/orders" });
      expect(data.note).toMatch(/didn't confirm in time/);
    });

    it("explains a URL pattern that could never match, and stores nothing", async () => {
      const { browser, sent } = fakeBrowser();
      const { call } = await connect(browser);
      const { isError, data } = await call("set_mock", { url: "/orders", match_type: "exact" });
      expect(isError).toBe(true);
      expect(data).toEqual({ error: "not an absolute URL: /orders" });
      expect(sent).toEqual([]);
    });

    it("rejects input the schema doesn't allow", async () => {
      const { client } = await connect();
      const result = await client.callTool({
        name: "set_mock",
        arguments: { url: "*/orders", status: 700 },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/status/);
    });
  });

  describe("list_mocks", () => {
    it("is empty to begin with", async () => {
      const { call } = await connect();
      expect((await call("list_mocks")).data).toEqual({ mocks: [] });
    });

    it("lists mocks oldest first, with the fields set_mock takes", async () => {
      const { call } = await connect();
      await call("set_mock", {
        id: "orders",
        url: "/orders/\\d+",
        match_type: "regex",
        regex_flags: "i",
        method: "post",
        status: 201,
        body: { ok: true },
        headers: { "X-Mocked": "1" },
        expires_in_seconds: 120,
      });
      await call("set_mock", { url: "example.com", match_type: "domain" });
      expect((await call("list_mocks")).data).toEqual({
        mocks: [
          {
            id: "orders",
            url: "/orders/\\d+",
            match_type: "regex",
            regex_flags: "i",
            method: "POST",
            status: 201,
            body: { ok: true },
            headers: { "X-Mocked": "1" },
            expires_at: new Date(NOW + 120_000).toISOString(),
            expires_in_seconds: 120,
          },
          {
            id: "mock-1",
            url: "example.com",
            match_type: "domain",
            method: "*",
            status: 200,
            expires_at: new Date(NOW + 600_000).toISOString(),
            expires_in_seconds: 600,
          },
        ],
      });
    });
  });

  describe("clear_mocks", () => {
    it("removes every mock and tells the browser", async () => {
      const { browser, sent } = fakeBrowser();
      const { call } = await connect(browser);
      await call("set_mock", { url: "*/a" });
      await call("set_mock", { url: "*/b" });
      const { isError, data } = await call("clear_mocks");
      expect(isError).toBe(false);
      expect(data).toMatchObject({ cleared: ["mock-1", "mock-2"], not_found: [], applied: true });
      expect(sent.at(-1)).toEqual([]);
      expect((await call("list_mocks")).data.mocks).toEqual([]);
    });

    it("removes only the given ids, and says which it didn't find", async () => {
      const { browser, sent } = fakeBrowser();
      const { call } = await connect(browser);
      await call("set_mock", { id: "a", url: "*/a" });
      await call("set_mock", { id: "b", url: "*/b" });
      const { data } = await call("clear_mocks", { ids: ["a", "nope"] });
      expect(data).toMatchObject({ cleared: ["a"], not_found: ["nope"] });
      expect(sent.at(-1)?.map((r) => r.id)).toEqual(["b"]);
    });

    it("notes when no browser is connected", async () => {
      const { call } = await connect(fakeBrowser({ connected: false, applied: false }).browser);
      const { data } = await call("clear_mocks");
      expect(data.applied).toBe(false);
      expect(data.note).toMatch(/No browser is connected/);
    });
  });

  describe("get_matches", () => {
    const report = (ruleId: string, n = 1) => ({
      ruleId,
      method: "GET",
      url: `http://localhost:3000/api/${n}`,
      transport: "fetch" as const,
    });

    it("lists matched requests with the mock that answered them", async () => {
      const { call, matches } = await connect();
      matches.record(report("orders"));
      const { isError, data } = await call("get_matches");
      expect(isError).toBe(false);
      expect(data).toEqual({
        total: 1,
        matches: [
          {
            mock_id: "orders",
            method: "GET",
            url: "http://localhost:3000/api/1",
            transport: "fetch",
            at: new Date(NOW).toISOString(),
          },
        ],
      });
    });

    it("filters by mock id and by time", async () => {
      const { call, matches, setTime } = await connect();
      matches.record(report("a", 1));
      setTime(NOW + 5_000);
      matches.record(report("b", 2));
      matches.record(report("a", 3));
      const since = new Date(NOW + 5_000).toISOString();
      const { data } = await call("get_matches", { mock_id: "a", since });
      expect(data.matches.map((m: { url: string }) => m.url)).toEqual([
        "http://localhost:3000/api/3",
      ]);
    });

    it("returns the most recent matches up to the limit, with the total", async () => {
      const { call, matches } = await connect();
      for (let n = 1; n <= 5; n++) matches.record(report("a", n));
      const { data } = await call("get_matches", { limit: 2 });
      expect(data.total).toBe(5);
      expect(data.matches.map((m: { url: string }) => m.url)).toEqual([
        "http://localhost:3000/api/4",
        "http://localhost:3000/api/5",
      ]);
    });

    it("explains what to check when nothing matched", async () => {
      const { call } = await connect();
      const { data } = await call("get_matches");
      expect(data.total).toBe(0);
      expect(data.note).toMatch(/reload the page/);
    });

    it("rejects a since that isn't a timestamp", async () => {
      const { call } = await connect();
      const { isError, data } = await call("get_matches", { since: "yesterday" });
      expect(isError).toBe(true);
      expect(data.error).toMatch(/since/);
    });
  });

  describe("status", () => {
    it("reports a connected browser and the live mocks", async () => {
      const { call } = await connect();
      await call("set_mock", { url: "*/a" });
      const { isError, data } = await call("status");
      expect(isError).toBe(false);
      expect(data).toEqual({
        extension_connected: true,
        port: 47821,
        active_mocks: 1,
        version: "test",
        note: "Ready: mocks set now reach the browser.",
      });
    });

    it("says what to open when no browser is connected", async () => {
      const { call } = await connect(fakeBrowser({ connected: false }).browser);
      const { data } = await call("status");
      expect(data.extension_connected).toBe(false);
      expect(data.note).toMatch(/open Chrome with the AgentProxy extension loaded/);
    });

    it("reports why the server can't reach the browser", async () => {
      const { call } = await connect(fakeBrowser({ connected: false }).browser, {
        error: "port 47821 is already in use",
      });
      const { data } = await call("status");
      expect(data).toMatchObject({
        extension_connected: false,
        error: "port 47821 is already in use",
      });
      expect(data.port).toBeUndefined();
      expect(data.note).toMatch(/port 47821 is already in use/);
    });
  });
});
