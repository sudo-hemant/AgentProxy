// A Playwright test with the built extension loaded into Chromium, plus the test app and API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MatchReport, MockRule } from "@agentproxy/shared";
import { type BrowserContext, test as base, chromium, type Worker } from "@playwright/test";
import { type RunningServer, startApi, startApp } from "./servers.js";

const EXTENSION_DIR = fileURLToPath(new URL("../../packages/extension/dist", import.meta.url));

/** What the background puts on `globalThis.agentproxy` (see packages/extension/src/background.ts). */
interface BackgroundHandle {
  setRules(rules: MockRule[]): Promise<void>;
  getMatches(): MatchReport[];
}

interface Fixtures {
  api: RunningServer;
  app: RunningServer;
  context: BrowserContext;
  /** The extension's service worker. */
  background: Worker;
  /** Replaces the extension's rules, as the server will from step 4 on. */
  setRules(rules: MockRule[]): Promise<void>;
  getMatches(): Promise<MatchReport[]>;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright needs the destructuring pattern.
  api: async ({}, use) => {
    const api = await startApi();
    await use(api);
    await api.close();
  },
  app: async ({ api }, use) => {
    const app = await startApp(api.url);
    await use(app);
    await app.close();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright needs the destructuring pattern.
  context: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), "agentproxy-e2e-"));
    const context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", // the full Chromium build, which can load extensions headless
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    await use(context);
    await context.close();
    await rm(profile, { recursive: true, force: true });
  },
  background: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    // Wait until background.ts has run and exposed its handle.
    await worker.evaluate(async () => {
      while (!("agentproxy" in globalThis)) await new Promise((r) => setTimeout(r, 10));
    });
    await use(worker);
  },
  setRules: async ({ background }, use) => {
    await use((rules) =>
      background.evaluate(
        (r) => (globalThis as unknown as { agentproxy: BackgroundHandle }).agentproxy.setRules(r),
        rules,
      ),
    );
  },
  getMatches: async ({ background }, use) => {
    await use(() =>
      background.evaluate(() =>
        (globalThis as unknown as { agentproxy: BackgroundHandle }).agentproxy.getMatches(),
      ),
    );
  },
});

export const expect = test.expect;
