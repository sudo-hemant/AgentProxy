// The real `agentproxy` command, started the way an agent starts it: over stdio.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";

const CLI = fileURLToPath(new URL("../../packages/server/dist/index.js", import.meta.url));

test("the agentproxy command serves the tools over stdio", async () => {
  const extensionDir = await mkdtemp(join(tmpdir(), "agentproxy-cli-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: {
      ...process.env,
      AGENTPROXY_PORT: "0",
      AGENTPROXY_EXTENSION_DIR: extensionDir,
    } as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    ["clear_mocks", "get_matches", "list_mocks", "set_mock", "status"].sort(),
  );
  const result = await client.callTool({ name: "status", arguments: {} });
  const status = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");
  expect(status).toMatchObject({ extension_connected: false, active_mocks: 0 });
  expect(status.port).toBeGreaterThan(0);

  // It paired the extension folder with the port it actually listens on.
  const config = JSON.parse(await readFile(join(extensionDir, "config.json"), "utf8"));
  expect(config).toEqual({ port: status.port, token: expect.stringMatching(/^[0-9a-f]{32}$/) });

  // close() ends the command's stdin, and only sends SIGTERM if it is still running 2 s later.
  // Finishing well within that shows the command exited on its own.
  const started = Date.now();
  await client.close();
  expect(Date.now() - started).toBeLessThan(1500);
  // Only the start-up line: no errors or warnings, on the way in or out.
  expect(stderr.trim().split("\n")).toEqual([
    expect.stringMatching(/^agentproxy .*: waiting for the extension on 127\.0\.0\.1:\d+$/),
  ]);
  await rm(extensionDir, { recursive: true, force: true });
});
