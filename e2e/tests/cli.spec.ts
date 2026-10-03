// The real `agentproxy` command, started the way an agent starts it: over stdio.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";

const CLI = fileURLToPath(new URL("../../packages/server/dist/index.js", import.meta.url));

test("the agentproxy command serves the tools over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: { ...process.env, AGENTPROXY_PORT: "0" } as Record<string, string>,
    stderr: "pipe",
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

  // close() ends the command's stdin, and only sends SIGTERM if it is still running 2 s later.
  // Finishing well within that shows the command exited on its own.
  const started = Date.now();
  await client.close();
  expect(Date.now() - started).toBeLessThan(1500);
});
