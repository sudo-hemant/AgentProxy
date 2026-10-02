// Spike 2: the realistic setup — app on localhost calls the team's backend on an HTTPS domain.
//   1. Can a redirect mock a request to another domain? Does it need host permission for it?
//   2. GraphQL: mock by operationName in-page; unmocked operations must keep their auth.
// Runs the same page against two copies of the extension with different host_permissions.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTROL = "http://127.0.0.1:59999/control";
const API = "https://api.example.test:4443";
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${JSON.stringify(detail)}` : ""}`);
};
const status = () => fetch(`${CONTROL}/status`).then((r) => r.json());
const addRule = (rule) =>
  fetch(`${CONTROL}/rules`, { method: "POST", body: JSON.stringify(rule) }).then((r) => r.json());
const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const procs = ["server.js", "app.js", "external-api.js"].map((f) =>
  spawn("node", [f], { cwd: here, stdio: ["ignore", "ignore", "inherit"] })
);
const cleanup = () => procs.forEach((p) => p.kill());
process.on("exit", cleanup);
await sleep(1500); // server writes extension/config.js; external-api generates its cert

// Rules (pushed to whichever extension copy connects).
await addRule({ id: "rest-orders", via: "redirect", urlFilter: `|${API}/orders|`, method: "GET", status: 500, body: { error: "mocked REST" } });
const { version } = await addRule({
  id: "gql-get-orders",
  match: { url: `${API}/graphql`, method: "POST", operationName: "GetOrders" },
  status: 200,
  body: { data: { orders: [], mocked: true } },
});

const variants = [
  { name: "localhost-only", hosts: ["http://localhost/*", "http://127.0.0.1/*"] },
  { name: "plus-api-domain", hosts: ["http://localhost/*", "http://127.0.0.1/*", "https://api.example.test/*"] },
];

for (const variant of variants) {
  console.log(`\n=== Extension with host_permissions: ${variant.name} ===`);
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), `spike-ext-${variant.name}-`));
  fs.cpSync(path.join(here, "extension"), extDir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  manifest.host_permissions = variant.hosts;
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "spike-")), {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true, // self-signed cert on the fake API domain
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--host-resolver-rules=MAP api.example.test 127.0.0.1",
    ],
  });

  try {
    await waitFor(async () => (await status()).extensionConnected, 10000, "extension connect");
    await waitFor(async () => (await status()).lastAppliedVersion >= version, 5000, "rules applied");
    await fetch(`${CONTROL}/reset-log`);

    const page = await context.newPage();
    await page.goto("http://localhost:3000/external");
    await page.waitForFunction(() => window.__done === true, null, { timeout: 15000 });
    const r = await page.evaluate(() => window.__results);
    await sleep(300); // let match reports reach the server
    const s = await status();
    const restHit = s.matches.find((m) => m.id === "rest-orders" && !m.preflight);
    const restPreflight = s.matches.find((m) => m.id === "rest-orders" && m.preflight);

    const restMocked = r.restGet.status === 500 && r.restGet.body?.includes("mocked REST");
    check(`[${variant.name}] REST call to other domain is mocked by redirect`, restMocked, {
      status: r.restGet.status,
      body: r.restGet.body ?? r.restGet.error,
    });
    if (restHit || restPreflight) {
      console.log("      what the mock server saw:", JSON.stringify({ restPreflight, restHit }));
    }

    const ordersBody = r.gqlGetOrders.body ?? "";
    check(`[${variant.name}] GraphQL GetOrders mocked on page load`, ordersBody.includes('"mocked":true'), {
      body: ordersBody || r.gqlGetOrders.error,
    });

    const userBody = JSON.parse(r.gqlGetUser.body ?? "{}");
    check(
      `[${variant.name}] GraphQL GetUser reaches REAL API with auth intact`,
      userBody.data?.source === "REAL external API" && userBody.data?.auth === "Bearer real-user-token",
      { body: r.gqlGetUser.body ?? r.gqlGetUser.error }
    );

    check(`[${variant.name}] GraphQL match reported to server`, s.matches.some((m) => m.id === "gql-get-orders"), {
      hits: s.matches.filter((m) => !m.preflight).map((m) => `${m.via}:${m.id}`),
    });
  } catch (e) {
    check(`[${variant.name}] run`, false, { error: String(e) });
  } finally {
    await context.close();
    await sleep(500);
  }
}

fs.mkdirSync(path.join(here, "results"), { recursive: true });
fs.writeFileSync(path.join(here, "results", "run-2-external-and-graphql.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed → results/run-2-external-and-graphql.json`);
cleanup();
process.exit(0);
