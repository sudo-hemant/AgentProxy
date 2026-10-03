import { EXTENSION_ORIGIN } from "@agentproxy/shared";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Bridge, startBridge } from "./bridge.js";
import { createMatchLog } from "./match-log.js";
import { type BrowserLink, createMcpServer, type Listening } from "./mcp.js";
import { createMockStore } from "./mock-store.js";
import type { Settings } from "./settings.js";

export interface AgentProxyOptions extends Settings {
  version: string;
  /** How the agent talks to us: stdio for the real command, in-memory for tests. */
  transport: Transport;
}

export interface AgentProxy {
  listening: Listening;
  close(): Promise<void>;
}

/** A browser link for when the bridge couldn't start: nothing ever reaches a browser. */
const NO_BROWSER: BrowserLink = {
  setRules: async () => ({ version: 0, applied: false }),
  isConnected: () => false,
};

/**
 * Starts AgentProxy: the bridge the extension connects to, and the MCP tools the agent calls.
 * If the bridge can't listen, the tools still start and explain the problem through `status`.
 */
export async function startAgentProxy(options: AgentProxyOptions): Promise<AgentProxy> {
  const store = createMockStore();
  const matches = createMatchLog();

  let bridge: Bridge | undefined;
  let listening: Listening;
  try {
    bridge = await startBridge({
      port: options.port,
      token: options.token,
      extensionOrigin: EXTENSION_ORIGIN,
      onMatch: (match) => matches.record(match),
    });
    listening = { port: bridge.port };
  } catch (error) {
    listening = { error: describeListenError(error, options.port) };
  }

  const server = createMcpServer({
    browser: bridge ?? NO_BROWSER,
    listening,
    store,
    matches,
    version: options.version,
  });
  await server.connect(options.transport);

  return {
    listening,
    async close() {
      await server.close();
      await bridge?.close();
    },
  };
}

function describeListenError(error: unknown, port: number): string {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return (
      `port ${port} is already in use, probably by another AgentProxy (for example from ` +
      "another agent session). Set AGENTPROXY_PORT to another port and pair the extension with it."
    );
  }
  return `couldn't listen on port ${port}: ${(error as Error).message}`;
}
