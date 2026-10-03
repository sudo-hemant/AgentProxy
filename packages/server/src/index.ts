#!/usr/bin/env node
// The `agentproxy` command.
// - `agentproxy`: an MCP server on stdio for the agent, plus the local WebSocket the Chrome
//   extension connects to. stdout carries the MCP protocol, so messages go to stderr.
// - `agentproxy setup`: pairs the extension and registers the server with Claude Code.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startAgentProxy } from "./main.js";
import { readSettings, type Settings } from "./settings.js";
import { type CommandResult, parseSetupArgs, runSetup } from "./setup.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const [subcommand, ...args] = process.argv.slice(2);

let settings: Settings;
try {
  // In the repo, the built extension sits next to the server: packages/extension/dist.
  const defaultExtensionDir = fileURLToPath(new URL("../../extension/dist", import.meta.url));
  settings = readSettings(process.env, defaultExtensionDir);
} catch (error) {
  console.error(`agentproxy: ${(error as Error).message}`);
  process.exit(1);
}

if (subcommand === "setup") {
  process.exit(await setup(args));
} else if (subcommand !== undefined) {
  console.error(`agentproxy: unknown command "${subcommand}". Did you mean "agentproxy setup"?`);
  process.exit(1);
} else {
  await serve();
}

async function setup(argv: string[]): Promise<number> {
  try {
    return await runSetup({
      ...settings,
      ...parseSetupArgs(argv),
      nodePath: process.execPath,
      serverEntry: fileURLToPath(import.meta.url),
      run,
      print: (line) => console.log(line),
    });
  } catch (error) {
    console.error(`agentproxy setup: ${(error as Error).message}`);
    return 1;
  }
}

async function serve(): Promise<void> {
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
  // Closing the proxy closes the transport too, so this must only ever run once.
  let stopping = false;
  process.stdin.once("end", async () => {
    if (stopping) return;
    stopping = true;
    await proxy.close();
    process.exit(0);
  });
}

/** Runs a command, collecting its output. A command that isn't installed gives no exit code. */
function run(command: string, commandArgs: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", () => resolve({ code: undefined, output }));
    child.on("close", (code) => resolve({ code: code ?? undefined, output }));
  });
}
