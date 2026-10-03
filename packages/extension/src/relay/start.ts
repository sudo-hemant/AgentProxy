import {
  type ExtensionMessage,
  isPageMessage,
  type MockRule,
  PAGE_CHANNEL,
  type PageMessage,
} from "@agentproxy/shared";

/** The part of `chrome.runtime` the relay uses, so tests can pass a fake. */
export interface RelayRuntime {
  sendMessage(message: ExtensionMessage): Promise<unknown>;
  onMessage: { addListener(listener: (message: ExtensionMessage) => void): void };
}

/**
 * Bridges the page wrapper and the background. The page wrapper runs in the page's own world and
 * can't use extension APIs, so the relay fetches the rules from the background and posts them
 * into the page, and forwards the page's match reports to the background.
 * Returns a function that stops listening to the page.
 */
export function startRelay(win: Window, runtime: RelayRuntime): () => void {
  const origin = win.location.origin;
  let latestRequest = 0;

  /** Fetches the current rules and posts them into the page. */
  const pushRules = async () => {
    const request = ++latestRequest;
    let rules: MockRule[];
    try {
      const reply = await runtime.sendMessage({ type: "get-rules" });
      rules = Array.isArray(reply) ? reply : [];
    } catch {
      return; // the extension was reloaded or removed: this page keeps its last rules
    }
    // Replies can arrive out of order; only the newest request's rules are current.
    if (request !== latestRequest) return;
    const message: PageMessage = { channel: PAGE_CHANNEL, type: "rules", rules };
    win.postMessage(message, origin);
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== win || event.origin !== origin || !isPageMessage(event.data)) return;
    if (event.data.type === "need-rules") pushRules();
    if (event.data.type === "match") {
      runtime.sendMessage({ type: "match", match: event.data.match }).catch(() => {});
    }
  };
  win.addEventListener("message", onMessage);

  // The background announces rule changes, so open pages update without a reload.
  runtime.onMessage.addListener((message) => {
    if (message.type === "rules-updated") pushRules();
  });

  // Also push once on start, in case the page wrapper asked before this listener existed.
  pushRules();

  return () => win.removeEventListener("message", onMessage);
}
