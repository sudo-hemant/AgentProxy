import type { MockRule } from "@agentproxy/shared";

/**
 * Rules the extension starts with until the server connection (MVP step 4) supplies real ones.
 * Mocks `GET /api/agentproxy-demo` on any localhost page, so the extension can be tried by hand.
 */
export const DEMO_RULES: MockRule[] = [
  {
    id: "demo",
    match: {
      url: { kind: "wildcard", value: "http://localhost*/api/agentproxy-demo" },
      method: "GET",
    },
    response: { status: 200, body: { mockedBy: "agentproxy" } },
    expiresAt: Number.MAX_SAFE_INTEGER,
  },
];
