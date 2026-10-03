// MVP step 4: the extension connects to the server, confirms the rules it receives, keeps
// mocking while the server is gone, and reconnects and resyncs when the server comes back.
import type { MockRule } from "@agentproxy/shared";
import { expect, launchWithExtension, test } from "../fixtures/extension.js";

const ordersRule = (api: string, body: unknown): MockRule => ({
  id: "orders",
  match: { url: { kind: "exact", value: `${api}/orders` } },
  response: { status: 200, body },
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/** Fetches <api>/orders from the page and returns the body. */
const fetchOrders = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const r = await fetch(`${(window as unknown as { API: string }).API}/orders`);
    return r.json();
  });

test("the extension confirms each rule change", async ({ server, context: _context, api }) => {
  expect(server.bridge.isConnected()).toBe(true);
  expect(await server.bridge.setRules([ordersRule(api.url, { v: 1 })])).toMatchObject({
    applied: true,
  });
  expect(await server.bridge.setRules([])).toMatchObject({ applied: true });
});

test("keeps mocking while the server is down, and resyncs when it restarts", async ({
  server,
  setRules,
  app,
  api,
  page,
}) => {
  await setRules([ordersRule(api.url, { from: "first server" })]);
  await page.goto(app.url);
  expect(await fetchOrders(page)).toEqual({ from: "first server" });

  await server.stop();
  await expect.poll(() => server.bridge.isConnected()).toBe(false);
  expect(await fetchOrders(page)).toEqual({ from: "first server" }); // the last rules stay

  await server.restart();
  // A restarted server starts with no rules until told otherwise; set some before the
  // extension is back, so they reach it as soon as it reconnects.
  await server.bridge.setRules([ordersRule(api.url, { from: "restarted server" })]);
  await expect.poll(() => server.bridge.isConnected(), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fetchOrders(page)).toEqual({ from: "restarted server" });
});

test("an extension loaded before pairing connects once config.json appears", async ({
  server,
  api,
}) => {
  const browser = await launchWithExtension(undefined);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(server.bridge.isConnected()).toBe(false);

    await browser.pair(server.bridge.port); // what `agentproxy` does when it starts
    await expect.poll(() => server.bridge.isConnected(), { timeout: 10_000 }).toBe(true);
    expect(await server.bridge.setRules([ordersRule(api.url, {})])).toMatchObject({
      applied: true,
    });
  } finally {
    await browser.close();
  }
});
