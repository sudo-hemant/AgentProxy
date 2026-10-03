import {
  isPageMessage,
  type MatchReport,
  PAGE_CHANNEL,
  type PageMessage,
} from "@agentproxy/shared";
import { createMockFetch } from "./fetch-wrapper.js";
import { createRuleStore } from "./rule-store.js";
import { installXhrWrapper } from "./xhr-wrapper.js";

/**
 * Starts mocking in a page: replaces `fetch` and `XMLHttpRequest`, asks the relay for the rules,
 * applies each rule list the relay sends, and reports every mocked request back to it.
 * Returns a function that undoes all of it.
 */
export function startPageWrapper(win: Window & typeof globalThis): () => void {
  const store = createRuleStore();
  const origin = win.location.origin;
  const post = (message: PageMessage) => win.postMessage(message, origin);
  const reportMatch = (match: MatchReport) => post({ channel: PAGE_CHANNEL, type: "match", match });
  const getBaseUrl = () => win.document.baseURI;

  // Only rules posted on this same window, from this page's origin. The relay posts from here.
  const onMessage = (event: MessageEvent) => {
    if (event.source !== win || event.origin !== origin || !isPageMessage(event.data)) return;
    if (event.data.type === "rules") store.setRules(event.data.rules);
  };
  win.addEventListener("message", onMessage);

  const realFetch = win.fetch;
  win.fetch = createMockFetch(realFetch.bind(win), store, reportMatch, getBaseUrl);
  const uninstallXhr = installXhrWrapper(win.XMLHttpRequest, store, reportMatch, getBaseUrl);

  post({ channel: PAGE_CHANNEL, type: "need-rules" });

  return () => {
    win.removeEventListener("message", onMessage);
    win.fetch = realFetch;
    uninstallXhr();
  };
}
