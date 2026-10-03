import type { MockRule } from "@agentproxy/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { MatchLog } from "./match-log.js";
import { mockInputShape, toMockRule } from "./mock-input.js";
import type { MockStore } from "./mock-store.js";
import type { SetRulesResult } from "./rule-sync.js";

/** The browser side, as the tools see it: the bridge, or a stand-in when it couldn't start. */
export interface BrowserLink {
  setRules(rules: MockRule[]): Promise<SetRulesResult>;
  isConnected(): boolean;
}

export interface McpServerDeps {
  browser: BrowserLink;
  store: MockStore;
  matches: MatchLog;
  version: string;
  now?: () => number;
  newId?: () => string;
}

/** The MCP server that gives the agent its tools. */
export function createMcpServer({
  browser,
  store,
  version,
  now = Date.now,
  newId = defaultId,
}: McpServerDeps): McpServer {
  const server = new McpServer({ name: "agentproxy", version });

  /** Sends the store's mocks to the browser and says what the agent should know about it. */
  const sync = async (): Promise<{ applied: boolean; note: string }> => {
    const { applied } = await browser.setRules(store.list());
    return { applied, note: syncNote(applied, browser.isConnected()) };
  };

  server.registerTool(
    "set_mock",
    {
      title: "Set a mock",
      description:
        "Mock the response to API requests the app makes from localhost pages in Chrome, " +
        "via fetch or XMLHttpRequest. Matching requests get this status, body and headers " +
        "without reaching the network; other requests are untouched. The mock expires on its " +
        "own. It applies to requests made after it is set: reload the page or repeat the action.",
      inputSchema: mockInputShape,
    },
    async (input) => {
      const result = toMockRule(input, now(), newId);
      if (!result.ok) return reply({ error: result.errors.join("; ") }, true);
      const { replaced } = store.set(result.rule);
      return reply({
        id: result.rule.id,
        replaced,
        expires_at: new Date(result.rule.expiresAt).toISOString(),
        ...(await sync()),
      });
    },
  );

  server.registerTool(
    "list_mocks",
    {
      title: "List mocks",
      description: "List the mocks in effect, oldest first. When several match, the newest wins.",
      annotations: { readOnlyHint: true },
    },
    async () => reply({ mocks: store.list().map((rule) => describeRule(rule, now())) }),
  );

  server.registerTool(
    "clear_mocks",
    {
      title: "Clear mocks",
      description:
        "Remove mocks so the affected requests reach the real API again. Removes all mocks, " +
        "or only the given ids.",
      inputSchema: {
        ids: z
          .array(z.string())
          .optional()
          .describe("Ids of the mocks to remove. Removes every mock if left out."),
      },
    },
    async ({ ids }) => {
      const { cleared, notFound } = store.clear(ids);
      return reply({ cleared, not_found: notFound, ...(await sync()) });
    },
  );

  return server;
}

/** The agent-facing view of a mock: the same field names `set_mock` takes. */
function describeRule(rule: MockRule, now: number) {
  const { url, method } = rule.match;
  return {
    id: rule.id,
    url: url.value,
    match_type: url.kind,
    ...(url.kind === "regex" && url.flags ? { regex_flags: url.flags } : {}),
    method: method ?? "*",
    status: rule.response.status,
    ...(rule.response.body !== undefined ? { body: rule.response.body } : {}),
    ...(rule.response.headers ? { headers: rule.response.headers } : {}),
    expires_at: new Date(rule.expiresAt).toISOString(),
    expires_in_seconds: Math.max(0, Math.round((rule.expiresAt - now) / 1000)),
  };
}

function syncNote(applied: boolean, connected: boolean): string {
  if (applied) {
    return "Active in the browser. It applies to new requests: reload the page if needed.";
  }
  if (!connected) {
    return (
      "No browser is connected, so this isn't active yet. Open Chrome with the AgentProxy " +
      "extension; it gets the current mocks as soon as it connects."
    );
  }
  return "The browser didn't confirm in time. It may still apply; check with get_matches.";
}

function reply(data: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError };
}

function defaultId(): string {
  return `mock-${Math.random().toString(36).slice(2, 8)}`;
}
