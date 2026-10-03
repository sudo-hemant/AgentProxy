import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT } from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandResult, parseSetupArgs, runSetup, type SetupOptions } from "./setup.js";

let dir: string;
let extensionDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproxy-setup-"));
  extensionDir = join(dir, "dist");
  await mkdir(extensionDir);
  await writeFile(join(extensionDir, "manifest.json"), "{}");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs setup with a fake command runner; `claude` answers as given. */
async function setup(
  overrides: Partial<SetupOptions> = {},
  claude: (args: string[]) => CommandResult = () => ({ code: 0, output: "" }),
) {
  const commands: string[][] = [];
  const printed: string[] = [];
  const code = await runSetup({
    scope: "user",
    register: true,
    extensionDir,
    port: DEFAULT_PORT,
    nodePath: "/usr/bin/node",
    serverEntry: "/repo/packages/server/dist/index.js",
    run: async (command, args) => {
      commands.push([command, ...args]);
      return claude(args);
    },
    print: (line) => printed.push(line),
    ...overrides,
  });
  return { code, commands, output: printed.join("\n") };
}

const config = async () => JSON.parse(await readFile(join(extensionDir, "config.json"), "utf8"));

describe("parseSetupArgs", () => {
  it("registers at user scope by default", () => {
    expect(parseSetupArgs([])).toEqual({ scope: "user", register: true });
  });

  it("reads --scope and --no-register", () => {
    expect(parseSetupArgs(["--scope", "project", "--no-register"])).toEqual({
      scope: "project",
      register: false,
    });
  });

  it("rejects an unknown scope or flag", () => {
    expect(() => parseSetupArgs(["--scope", "global"])).toThrow(/--scope must be one of/);
    expect(() => parseSetupArgs(["--force"])).toThrow();
  });
});

describe("runSetup", () => {
  it("pairs the extension on the default port with a new token", async () => {
    const { code, output } = await setup();
    expect(code).toBe(0);
    expect(await config()).toEqual({
      port: DEFAULT_PORT,
      token: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(output).toContain(`Paired the extension: ${join(extensionDir, "config.json")}`);
  });

  it("keeps an existing token", async () => {
    await writeFile(join(extensionDir, "config.json"), '{"port":1234,"token":"kept"}');
    await setup();
    expect(await config()).toEqual({ port: DEFAULT_PORT, token: "kept" });
  });

  it("registers with Claude Code, replacing any earlier registration", async () => {
    const { code, commands, output } = await setup();
    expect(code).toBe(0);
    expect(commands).toEqual([
      ["claude", "--version"],
      ["claude", "mcp", "remove", "--scope", "user", "agentproxy"],
      [
        "claude",
        "mcp",
        "add",
        "--scope",
        "user",
        "agentproxy",
        "--",
        "/usr/bin/node",
        "/repo/packages/server/dist/index.js",
      ],
    ]);
    expect(output).toContain('Registered with Claude Code (user scope) as "agentproxy".');
  });

  it("passes a non-default port to the registered server", async () => {
    const { commands } = await setup({ port: 5000, scope: "project" });
    expect(commands.at(-1)).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "project",
      "-e",
      "AGENTPROXY_PORT=5000",
      "agentproxy",
      "--",
      "/usr/bin/node",
      "/repo/packages/server/dist/index.js",
    ]);
    expect((await config()).port).toBe(5000);
  });

  it("prints a config for other MCP clients when Claude Code isn't installed", async () => {
    const { code, commands, output } = await setup({ port: 5000 }, () => ({
      code: undefined,
      output: "",
    }));
    expect(code).toBe(0);
    expect(commands).toEqual([["claude", "--version"]]);
    expect(output).toContain('"command": "/usr/bin/node"');
    expect(output).toContain('"AGENTPROXY_PORT": "5000"');
  });

  it("only pairs with --no-register", async () => {
    const { code, commands, output } = await setup({ register: false });
    expect(code).toBe(0);
    expect(commands).toEqual([]);
    expect(output).toContain("--no-register");
    expect(await config()).toMatchObject({ port: DEFAULT_PORT });
  });

  it("fails, showing the command to run by hand, when registering fails", async () => {
    const { code, output } = await setup({}, (args) =>
      args[1] === "add" ? { code: 1, output: "boom" } : { code: 0, output: "" },
    );
    expect(code).toBe(1);
    expect(output).toContain("Registering with Claude Code failed:\nboom");
    expect(output).toContain("To try by hand: claude mcp add --scope user agentproxy -- ");
  });

  it("says how to load the extension", async () => {
    const { output } = await setup();
    expect(output).toContain(`Click "Load unpacked" and choose ${extensionDir}`);
  });

  it("asks for a build when the extension isn't built", async () => {
    await rm(join(extensionDir, "manifest.json"));
    const { code, commands, output } = await setup();
    expect(code).toBe(1);
    expect(output).toContain('Run "pnpm build" first.');
    expect(commands).toEqual([]);
  });

  it("refuses port 0, which the extension couldn't be paired with", async () => {
    const { code, output } = await setup({ port: 0 });
    expect(code).toBe(1);
    expect(output).toMatch(/fixed port/);
  });
});
