import type { MockRule } from "./rule.js";

// Messages inside the extension. The page wrapper and the relay talk over window.postMessage,
// which every script on the page can also use, so those messages carry a channel tag and are
// checked with `isPageMessage`. The relay and the background talk over chrome.runtime messaging,
// which only our own extension can reach.

/** Tags our messages on window.postMessage so they can't be confused with the app's own. */
export const PAGE_CHANNEL = "agentproxy";

/** One request answered by a mock, reported back so the agent can see what matched. */
export interface MatchReport {
  ruleId: string;
  method: string;
  url: string;
  transport: "fetch" | "xhr";
}

/** Page wrapper ⇄ relay, over window.postMessage. */
export type PageMessage =
  /** Page → relay: send me the current rules. */
  | { channel: typeof PAGE_CHANNEL; type: "need-rules" }
  /** Relay → page: the full current rule list, replacing any earlier one. */
  | { channel: typeof PAGE_CHANNEL; type: "rules"; rules: MockRule[] }
  /** Page → relay: a request was answered by a mock. */
  | { channel: typeof PAGE_CHANNEL; type: "match"; match: MatchReport };

/** Relay ⇄ background, over chrome.runtime messaging. */
export type ExtensionMessage =
  /** Relay → background: reply with the current rules (`MockRule[]`). */
  | { type: "get-rules" }
  /** Background → relays in open tabs: the rules changed, fetch them again. */
  | { type: "rules-updated" }
  /** Relay → background: forwards a page's match report. */
  | { type: "match"; match: MatchReport };

const PAGE_MESSAGE_TYPES = new Set<string>(["need-rules", "rules", "match"]);

/** Whether `data` from a window message event is one of our page messages. */
export function isPageMessage(data: unknown): data is PageMessage {
  if (typeof data !== "object" || data === null) return false;
  const { channel, type } = data as { channel?: unknown; type?: unknown };
  return channel === PAGE_CHANNEL && typeof type === "string" && PAGE_MESSAGE_TYPES.has(type);
}
