// MVP step 3: the extension, given rules directly in its service worker, mocks fetch and axios
// in a localhost page, leaves other requests and their auth alone, applies rules during page
// load, and picks up rule changes without a reload.
import type { MockRule } from "@agentproxy/shared";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/extension.js";

const FOREVER = Number.MAX_SAFE_INTEGER;

/** A rule answering GET <api>/orders with a 500 and a recognisable body. */
const ordersRule = (api: string, body: unknown = { mocked: true }): MockRule => ({
  id: "orders-500",
  match: { url: { kind: "exact", value: `${api}/orders` }, method: "GET" },
  response: { status: 500, body },
  expiresAt: FOREVER,
});

type ApiResult = { status: number; body: { source?: string; auth?: string | null } };

/** Calls the API from the page with fetch, sending the app's login token. */
const pageFetch = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const w = window as unknown as { API: string; TOKEN: string };
    const r = await fetch(w.API + p, { headers: { Authorization: w.TOKEN } });
    return { status: r.status, body: await r.json() };
  }, path) as Promise<ApiResult>;

/** Calls the API from the page with axios, sending the app's login token. */
const pageAxios = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    type AxiosLike = {
      get(url: string, config: object): Promise<{ status: number; data: unknown }>;
    };
    const w = window as unknown as { API: string; TOKEN: string; axios: AxiosLike };
    const r = await w.axios.get(w.API + p, {
      headers: { Authorization: w.TOKEN },
      validateStatus: () => true,
    });
    return { status: r.status, body: r.data };
  }, path) as Promise<ApiResult>;

test("mocks a fetch made while the page is still loading", async ({ app, api, page, setRules }) => {
  await setRules([ordersRule(api.url)]);
  await page.goto(app.url);
  const result = await page.evaluate(
    () => (window as unknown as { onLoadResult: Promise<unknown> }).onLoadResult,
  );
  expect(result).toEqual({ status: 500, body: { mocked: true } });
});

test("mocks fetch and axios calls", async ({ app, api, page, setRules }) => {
  await setRules([ordersRule(api.url)]);
  await page.goto(app.url);
  expect(await pageFetch(page, "/orders")).toEqual({ status: 500, body: { mocked: true } });
  expect(await pageAxios(page, "/orders")).toEqual({ status: 500, body: { mocked: true } });
});

test("sends other requests to the real API with their login token", async ({
  app,
  api,
  page,
  setRules,
}) => {
  await setRules([ordersRule(api.url)]);
  await page.goto(app.url);
  const real = { source: "real", path: "/users", auth: "Bearer test-token" };
  expect(await pageFetch(page, "/users")).toEqual({ status: 200, body: real });
  expect(await pageAxios(page, "/users")).toEqual({ status: 200, body: real });
});

test("applies rule changes to an open page without a reload", async ({
  app,
  api,
  page,
  setRules,
}) => {
  await setRules([ordersRule(api.url, { version: 1 })]);
  await page.goto(app.url);
  expect((await pageFetch(page, "/orders")).body).toEqual({ version: 1 });

  await setRules([ordersRule(api.url, { version: 2 })]);
  await expect.poll(async () => (await pageFetch(page, "/orders")).body).toEqual({ version: 2 });

  await setRules([]);
  await expect.poll(async () => (await pageFetch(page, "/orders")).body.source).toBe("real");
});

test("reports which requests the mocks answered", async ({
  app,
  api,
  page,
  setRules,
  getMatches,
}) => {
  await setRules([ordersRule(api.url)]);
  await page.goto(app.url);
  await page.evaluate(() => (window as unknown as { onLoadResult: Promise<unknown> }).onLoadResult);
  await pageAxios(page, "/orders");
  await pageFetch(page, "/users"); // not mocked: not reported

  await expect.poll(getMatches).toEqual([
    { ruleId: "orders-500", method: "GET", url: `${api.url}/orders`, transport: "fetch" },
    { ruleId: "orders-500", method: "GET", url: `${api.url}/orders`, transport: "xhr" },
  ]);
});
