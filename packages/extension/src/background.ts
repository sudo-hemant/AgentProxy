// The extension's service worker. It holds the rules, hands them to the relays, and keeps the
// match reports the relays forward. Until MVP step 4 connects it to the server, it starts with
// the demo rules.
import type { ExtensionMessage } from "@agentproxy/shared";
import { DEMO_RULES } from "./background/demo-rules.js";
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
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) =>
  background.handleMessage(message, sendResponse),
);

background.seedRules(DEMO_RULES);

// Reachable from the service worker console, and from tests, until the server drives the rules.
Object.assign(globalThis, { agentproxy: background });
