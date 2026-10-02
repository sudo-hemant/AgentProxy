// Runs the spike end to end:
//   node run-spike.js                          full run (idle check: 300s with keepalive pings)
//   PING_MS=0 IDLE_SECONDS=90 node run-spike.js  control run: no pings, to see if the worker gets killed
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, "extension");
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS ?? 300);
const CONTROL = "http://127.0.0.1:59999/control";
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
    if (await fn()) return Date.now() - start;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const waitApplied = (version) =>
  waitFor(async () => (await status()).lastAppliedVersion >= version, 5000, `rules v${version} applied`);

const procs = [
  spawn("node", ["server.js"], { cwd: here, stdio: "inherit", env: process.env }),
  spawn("node", ["app.js"], { cwd: here, stdio: "inherit" }),
];
const cleanup = () => procs.forEach((p) => p.kill());
process.on("exit", cleanup);

await sleep(800); // let server.js write extension/config.js before the extension loads

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "spike-")), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = await context.newPage();

const loadAppPage = async () => {
  await page.goto("http://localhost:3000/");
  await page.waitForFunction(() => window.__done === true, null, { timeout: 10000 });
  return page.evaluate(() => window.__results);
};

try {
  // ---------------------------------------------------------------------------------
  const connectMs = await waitFor(async () => (await status()).extensionConnected, 10000, "extension connect");
  check("Extension connects to local server", true, { ms: connectMs });

  // ---------------------------------------------------------------------------------
  const baseline = await loadAppPage();
  check("Baseline (no rules): app gets REAL backend", baseline.fetchGet.body?.includes("REAL backend"), {
    status: baseline.fetchGet.status,
  });

  // ---------------------------------------------------------------------------------
  await addRule({
    id: "get-orders-500",
    via: "redirect",
    urlFilter: "|http://localhost:3000/api/orders|",
    method: "GET",
    status: 500,
    body: { error: "mocked failure" },
  });
  const { version } = await addRule({
    id: "post-orders-201",
    via: "redirect",
    urlFilter: "|http://localhost:3000/api/orders|",
    method: "POST",
    status: 201,
    body: { mocked: true },
  });
  const applyMs = await waitApplied(version);
  check("Rules pushed and applied by extension", true, { msFromLastAddToApplied: applyMs });

  await fetch(`${CONTROL}/reset-log`);
  const mocked = await loadAppPage();
  const s = await status();
  const postHit = s.matches.find((m) => m.id === "post-orders-201" && !m.preflight);

  check("fetch GET on page load gets mocked 500", mocked.fetchGet.status === 500 && mocked.fetchGet.body.includes("mocked failure"), mocked.fetchGet);
  check("XHR GET gets mocked 500", mocked.xhrGet.status === 500, mocked.xhrGet);
  check("fetch POST gets mocked 201", mocked.fetchPost.status === 201, mocked.fetchPost);
  check("POST method preserved through redirect", postHit?.method === "POST", { method: postHit?.method });
  check("POST body preserved through redirect", postHit?.receivedBody === JSON.stringify({ item: "book", qty: 2 }), {
    receivedBody: postHit?.receivedBody,
  });
  check("credentials: include passes CORS (mock echoes origin)", mocked.fetchGet.status === 500, {
    originSeenByMock: postHit?.origin,
    preflights: s.matches.filter((m) => m.preflight).length,
    cookieSentToMock: postHit?.cookieHeader,
  });
  check("Server logged every match (agent can verify)", s.matches.filter((m) => !m.preflight).length >= 3, {
    hits: s.matches.filter((m) => !m.preflight).map((m) => `${m.method} ${m.id}`),
  });
  check("Visible side effect: app sees redirected response", true, {
    redirected: mocked.fetchGet.redirected,
    url: mocked.fetchGet.url,
  });

  // ---------------------------------------------------------------------------------
  const { token } = (await import(path.join(EXT, "config.js"))).CONFIG;
  const tryWs = (origin, tok) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:59999/?token=${tok}`, { origin });
      ws.on("open", () => (ws.close(), resolve("opened")));
      ws.on("error", () => resolve("rejected"));
    });
  check("Web page cannot open the control WebSocket", mocked.pageWebSocket.opened === false, mocked.pageWebSocket);
  check("Right token but website Origin is rejected", (await tryWs("http://localhost:3000", token)) === "rejected");
  check("Extension-looking Origin but wrong token is rejected", (await tryWs("chrome-extension://abc", "wrong")) === "rejected");

  // ---------------------------------------------------------------------------------
  console.log(`\n… idling ${IDLE_SECONDS}s with PING_MS=${process.env.PING_MS ?? 20000} (no page activity)\n`);
  await fetch(`${CONTROL}/reset-log`);
  await sleep(IDLE_SECONDS * 1000);
  const idle = await status();
  const drops = idle.events.filter((e) => e.type === "ws-closed").length;
  const restarts = new Set(idle.events.filter((e) => e.type === "ext-hello").map((e) => e.swInstance)).size;
  check(`Connection survived ${IDLE_SECONDS}s idle`, drops === 0 && idle.extensionConnected, {
    disconnects: drops,
    workerRestartsSeen: restarts,
  });

  const v2 = await addRule({
    id: "get-orders-500",
    via: "redirect",
    urlFilter: "|http://localhost:3000/api/orders|",
    method: "GET",
    status: 503,
    body: { error: "after idle" },
  });
  let afterIdleMs = null;
  try {
    afterIdleMs = await waitApplied(v2.version);
  } catch {}
  const afterIdle = await loadAppPage();
  check("Rule change after idle applies", afterIdle.fetchGet.status === 503, {
    msToApply: afterIdleMs,
    status: afterIdle.fetchGet.status,
  });
} catch (e) {
  check("Spike run", false, { error: String(e) });
} finally {
  fs.mkdirSync(path.join(here, "results"), { recursive: true });
  const file = path.join(here, "results", `run-ping${process.env.PING_MS ?? 20000}-idle${IDLE_SECONDS}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed → ${path.relative(here, file)}`);
  await context.close();
  cleanup();
  process.exit(0);
}
