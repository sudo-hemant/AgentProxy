#!/usr/bin/env node
// The `agentproxy` command: an MCP server on stdio for the agent, plus the local WebSocket the
// Chrome extension connects to. stdout carries the MCP protocol, so messages go to stderr.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startAgentProxy } from "./main.js";
import { readSettings } from "./settings.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

let settings: ReturnType<typeof readSettings>;
try {
  // In the repo, the built extension sits next to the server: packages/extension/dist.
  const defaultExtensionDir = fileURLToPath(new URL("../../extension/dist", import.meta.url));
  settings = readSettings(process.env, defaultExtensionDir);
} catch (error) {
  console.error(`agentproxy: ${(error as Error).message}`);
  process.exit(1);
}

const transport = new StdioServerTransport();
const proxy = await startAgentProxy({ ...settings, version, transport });

if ("port" in proxy.listening) {
  console.error(
    `agentproxy ${version}: waiting for the extension on 127.0.0.1:${proxy.listening.port}`,
  );
} else {
  console.error(`agentproxy ${version}: ${proxy.listening.error}`);
}
if ("error" in proxy.pairing) {
  console.error(`agentproxy: can't pair the extension: ${proxy.pairing.error}`);
}

// The agent closes our stdin when it's done; stop, so the open port doesn't keep us running.
const shutdown = async () => {
  await proxy.close();
  process.exit(0);
};
transport.onclose = shutdown;
process.stdin.once("end", shutdown);
