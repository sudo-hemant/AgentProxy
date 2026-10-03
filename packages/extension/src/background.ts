// The extension's service worker. It connects to the AgentProxy server, stores the rules the
// server sends, hands them to the relays, and reports matches back to the server.
import { EXTENSION_CONFIG_FILE, type ExtensionMessage } from "@agentproxy/shared";
import { loadConfig } from "./background/config.js";
import { createServerConnection, type ServerConnection } from "./background/connection.js";
import { createBackground } from "./background/rules.js";

const background = createBackground({
  storage: chrome.storage.session,
  async notifyTabs(message) {
    const tabs = await chrome.tabs.query({ url: "http://localhost/*" });
    await Promise.all(
      tabs.map(
        (tab) =>
          tab.id === undefined
            ? undefined
            : chrome.tabs.sendMessage(tab.id, message).catch(() => {}), // no relay in that tab yet
      ),
    );
  },
  onMatch: (match) => connection.sendMatch(match),
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) =>
  background.handleMessage(message, sendResponse),
);

const connection: ServerConnection = createServerConnection({
  loadConfig: () => loadConfig(fetch, chrome.runtime.getURL(EXTENSION_CONFIG_FILE)),
  createSocket: (url) => new WebSocket(url),
  applyRules: (rules) => background.setRules(rules),
});
connection.start();

// If Chrome stops the worker anyway, this alarm starts it again (30 s is the shortest period)
// and reconnects. Listeners must be added at the top level to wake the worker.
chrome.alarms.onAlarm.addListener(() => connection.start());
chrome.alarms.create("keep-connected", { periodInMinutes: 0.5 });
