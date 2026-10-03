// MVP step 5: an agent, through AgentProxy's MCP tools, mocks a request in the real browser,
// checks the mock took effect, clears it, and sees mocks expire on their own.
import type { Page } from "@playwright/test";
import { expect, agentTest as test } from "../fixtures/agent.js";

/** Fetches <api>/orders from the page and returns the status and body. */
const fetchOrders = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch(`${(window as unknown as { API: string }).API}/orders`);
    return { status: r.status, body: await r.json() };
  });

test("set a mock, see it in the page and in get_matches, then clear it", async ({
  callTool,
  app,
  api,
  page,
}) => {
  const set = await callTool("set_mock", {
    id: "orders-down",
    url: `${api.url}/orders`,
    match_type: "exact",
    method: "GET",
    status: 503,
    body: { error: "maintenance" },
  });
  expect(set).toMatchObject({ isError: false, data: { id: "orders-down", applied: true } });

  await page.goto(app.url);
  expect(await fetchOrders(page)).toEqual({ status: 503, body: { error: "maintenance" } });

  const matches = await callTool("get_matches", { mock_id: "orders-down" });
  expect(matches.data.matches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ mock_id: "orders-down", url: `${api.url}/orders` }),
    ]),
  );

  const listed = await callTool("list_mocks");
  expect(listed.data.mocks).toEqual([expect.objectContaining({ id: "orders-down", status: 503 })]);

  const cleared = await callTool("clear_mocks");
  expect(cleared.data).toMatchObject({ cleared: ["orders-down"], applied: true });
  expect((await fetchOrders(page)).body).toMatchObject({ source: "real" });
});

test("a mock stops applying once it expires", async ({ callTool, app, api, page }) => {
  await callTool("set_mock", {
    url: `${api.url}/orders`,
    status: 500,
    body: { short: "lived" },
    expires_in_seconds: 2,
  });
  await page.goto(app.url);
  expect((await fetchOrders(page)).body).toEqual({ short: "lived" });

  await expect.poll(async () => (await fetchOrders(page)).body.source).toBe("real");
  expect((await callTool("list_mocks")).data.mocks).toEqual([]);
});
