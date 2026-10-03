// A Playwright test with the built extension loaded into Chromium and connected to a real
// AgentProxy server, plus the test app and API.
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_CONFIG_FILE,
  EXTENSION_ORIGIN,
  type ExtensionConfig,
  type MatchReport,
  type MockRule,
} from "@agentproxy/shared";
import { type BrowserContext, test as base, chromium, expect } from "@playwright/test";
import { type Bridge, startBridge } from "agentproxy/bridge";
import { type RunningServer, startApi, startApp } from "./servers.js";

const BUILT_EXTENSION = fileURLToPath(new URL("../../packages/extension/dist", import.meta.url));
export const TOKEN = "e2e-pairing-token";

/** The AgentProxy server, as the tests see it. */
export interface ServerHandle {
  bridge: Bridge;
  /** Every match the extension reported, oldest first. */
  matches: MatchReport[];
  /** Stops the server, as if its process had exited. */
  stop(): Promise<void>;
  /** Starts a new server on the same port, as if it had been restarted. */
  restart(): Promise<void>;
}

interface Fixtures {
  api: RunningServer;
  app: RunningServer;
  server: ServerHandle;
  context: BrowserContext;
  /** Replaces the rules through the server and waits until the extension confirms them. */
  setRules(rules: MockRule[]): Promise<void>;
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
  server: async ({}, use) => {
    const matches: MatchReport[] = [];
    const start = (port: number) =>
      startBridge({
        port,
        token: TOKEN,
        extensionOrigin: EXTENSION_ORIGIN,
        onMatch: (match) => matches.push(match),
      });
    const handle: ServerHandle = {
      bridge: await start(0),
      matches,
      stop: () => handle.bridge.close(),
      restart: async () => {
        handle.bridge = await start(handle.bridge.port);
      },
    };
    await use(handle);
    await handle.bridge.close();
  },
  context: async ({ server }, use) => {
    const browser = await launchWithExtension(server.bridge.port);
    await expect
      .poll(() => server.bridge.isConnected(), { message: "extension connects" })
      .toBe(true);
    await use(browser.context);
    await browser.close();
  },
  setRules: async ({ server, context: _context }, use) => {
    await use(async (rules) => {
      const result = await server.bridge.setRules(rules);
      expect(result.applied, "the extension confirms the rules").toBe(true);
    });
  },
});

/**
 * Launches Chromium with a fresh copy of the built extension, paired with the server on `port`,
 * or not paired at all when `port` is undefined. The extension's ID comes from its manifest key,
 * so it doesn't depend on the folder.
 */
export async function launchWithExtension(port: number | undefined) {
  const extensionDir = await mkdtemp(join(tmpdir(), "agentproxy-ext-"));
  await cp(BUILT_EXTENSION, extensionDir, { recursive: true, filter: (src) => !isConfig(src) });
  const pair = (pairedPort: number) => {
    const config: ExtensionConfig = { port: pairedPort, token: TOKEN };
    return writeFile(join(extensionDir, EXTENSION_CONFIG_FILE), JSON.stringify(config));
  };
  if (port !== undefined) await pair(port);

  const profile = await mkdtemp(join(tmpdir(), "agentproxy-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // the full Chromium build, which can load extensions headless
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  return {
    context,
    /** Writes the pairing into the loaded extension's folder, as `agentproxy` would. */
    pair,
    async close() {
      await context.close();
      await rm(profile, { recursive: true, force: true });
      await rm(extensionDir, { recursive: true, force: true });
    },
  };
}

/** The developer's own dist/config.json must never leak into a test's copy. */
function isConfig(path: string): boolean {
  return path.endsWith(`/${EXTENSION_CONFIG_FILE}`);
}

export { expect };
