import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PORT } from "@agentproxy/shared";
import { configPath, readPairing, writePairing } from "./pairing.js";

export const SCOPES = ["user", "local", "project"] as const;
export type Scope = (typeof SCOPES)[number];

export interface SetupArgs {
  /** Claude Code configuration scope to register in. */
  scope: Scope;
  /** False to only pair the extension, without registering with an agent. */
  register: boolean;
}

/** Parses `agentproxy setup [--scope user|local|project] [--no-register]`. Throws on bad input. */
export function parseSetupArgs(argv: string[]): SetupArgs {
  const { values } = parseArgs({
    args: argv,
    options: { scope: { type: "string", default: "user" }, "no-register": { type: "boolean" } },
    strict: true,
  });
  const scope = values.scope as Scope;
  if (!SCOPES.includes(scope)) {
    throw new Error(`--scope must be one of ${SCOPES.join(", ")}, got "${values.scope}"`);
  }
  return { scope, register: !values["no-register"] };
}

export interface CommandResult {
  /** The exit code, or undefined if the command couldn't be started (e.g. not installed). */
  code: number | undefined;
  output: string;
}

export interface SetupOptions extends SetupArgs {
  extensionDir: string;
  port: number;
  /** Forces the pairing token; otherwise the existing one is kept, or a new one made. */
  token?: string;
  /** Absolute path of the node binary the agent should run the server with. */
  nodePath: string;
  /** Absolute path of the server's entry point (dist/index.js). */
  serverEntry: string;
  run(command: string, args: string[]): Promise<CommandResult>;
  print(line: string): void;
}

const SERVER_NAME = "agentproxy";

/**
 * `agentproxy setup`: pairs the built extension with the server, registers the server with
 * Claude Code (or prints the config for other MCP clients), and says how to load the extension.
 * Returns the process exit code.
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const { print } = options;

  if (options.port === 0) {
    print("Setup needs a fixed port: unset AGENTPROXY_PORT or set it to a port number.");
    return 1;
  }
  if (!(await exists(join(options.extensionDir, "manifest.json")))) {
    print(`No built extension in ${options.extensionDir}. Run "pnpm build" first.`);
    return 1;
  }

  const token = options.token ?? (await readPairing(options.extensionDir))?.token ?? randomToken();
  await writePairing(options.extensionDir, { port: options.port, token });
  print(`Paired the extension: ${configPath(options.extensionDir)}`);

  const env: Record<string, string> =
    options.port === DEFAULT_PORT ? {} : { AGENTPROXY_PORT: String(options.port) };
  if (options.register && !(await register(options, env))) return 1;
  if (!options.register) print("Skipped registering with an agent (--no-register).");

  print("");
  print("Next:");
  print("  1. In Chrome, open chrome://extensions and turn on Developer mode.");
  print(`  2. Click "Load unpacked" and choose ${options.extensionDir}`);
  print("  3. Start a new agent session and ask it to check AgentProxy's status.");
  return 0;
}

/** Registers with Claude Code if it is installed; otherwise prints a config to paste. */
async function register(options: SetupOptions, env: Record<string, string>): Promise<boolean> {
  const { run, print } = options;
  if ((await run("claude", ["--version"])).code !== 0) {
    print("Claude Code's `claude` command wasn't found. For other MCP clients, add this server:");
    print(JSON.stringify(mcpClientConfig(options, env), null, 2));
    return true;
  }

  // Replace any earlier registration, so running setup again is safe.
  await run("claude", ["mcp", "remove", "--scope", options.scope, SERVER_NAME]);
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  // The name goes first: -e takes several values and would swallow a name placed after it.
  const addArgs = [
    "mcp",
    "add",
    SERVER_NAME,
    "--scope",
    options.scope,
    ...envArgs,
    "--",
    options.nodePath,
    options.serverEntry,
  ];
  const added = await run("claude", addArgs);
  if (added.code !== 0) {
    print(`Registering with Claude Code failed:\n${added.output.trim()}`);
    print(`To try by hand: claude ${addArgs.map(quote).join(" ")}`);
    return false;
  }
  print(`Registered with Claude Code (${options.scope} scope) as "${SERVER_NAME}".`);
  return true;
}

/** The `mcpServers` entry most MCP clients (Cursor, Claude Desktop, ...) accept. */
function mcpClientConfig(options: SetupOptions, env: Record<string, string>) {
  return {
    mcpServers: {
      [SERVER_NAME]: {
        command: options.nodePath,
        args: [options.serverEntry],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    },
  };
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}
