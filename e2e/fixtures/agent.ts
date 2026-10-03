// A Playwright test where an MCP client drives AgentProxy's tools, as an agent would, against
// the built extension in Chromium, plus the test app and API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type BrowserContext, test as base, expect } from "@playwright/test";
import { startAgentProxy } from "agentproxy/main";
import { launchWithExtension, TOKEN } from "./extension.js";
import { type RunningServer, startApi, startApp } from "./servers.js";

/** Calls one of AgentProxy's tools and returns its parsed JSON reply. */
export type CallTool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ isError: boolean; data: Record<string, unknown> }>;

/** AgentProxy started in-process, and an MCP client calling its tools as an agent would. */
interface Agent {
  /** The port AgentProxy's bridge listens on, for pairing the extension. */
  port: number;
  callTool: CallTool;
}

interface Fixtures {
  api: RunningServer;
  app: RunningServer;
  agent: Agent;
  callTool: CallTool;
  context: BrowserContext;
}

export const agentTest = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright needs the destructuring pattern.
  api: async ({}, use) => {
    const api = await startApi();
    await use(api);
    await api.close();
  },
  app: async ({ api }, use) => {
    const app = await startApp(api.url);
    await use(app);
    await app.close();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright needs the destructuring pattern.
  agent: async ({}, use) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // AgentProxy writes its pairing here; the browser loads its own copy (launchWithExtension).
    const pairingDir = await mkdtemp(join(tmpdir(), "agentproxy-pairing-"));
    const proxy = await startAgentProxy({
      port: 0,
      token: TOKEN,
      extensionDir: pairingDir,
      version: "e2e",
      transport: serverTransport,
    });
    if (!("port" in proxy.listening)) throw new Error(proxy.listening.error);
    const client = new Client({ name: "e2e-agent", version: "1" });
    await client.connect(clientTransport);
    await use({
      port: proxy.listening.port,
      async callTool(name, args = {}) {
        const result = await client.callTool({ name, arguments: args });
        const text = (result.content as Array<{ text: string }>)[0]?.text ?? "{}";
        return { isError: result.isError === true, data: JSON.parse(text) };
      },
    });
    await client.close();
    await proxy.close();
    await rm(pairingDir, { recursive: true, force: true });
  },
  callTool: async ({ agent }, use) => {
    await use(agent.callTool);
  },
  context: async ({ agent }, use) => {
    const browser = await launchWithExtension(agent.port);
    await expect
      .poll(async () => (await agent.callTool("status")).data.extension_connected, {
        message: "extension connects",
      })
      .toBe(true);
    await use(browser.context);
    await browser.close();
  },
});

export { expect };
