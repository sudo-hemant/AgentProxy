import type { ExtensionMessage, MatchReport, MockRule } from "@agentproxy/shared";

const RULES_KEY = "rules";
/** How many recent match reports are kept. */
export const MAX_MATCHES = 100;

/** The browser APIs the background needs, so tests can pass fakes. */
export interface BackgroundDeps {
  /** `chrome.storage.session`: survives the service worker being stopped, not a browser restart. */
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** Sends a message to the relays in every open tab the extension covers. */
  notifyTabs(message: ExtensionMessage): Promise<void>;
}

export interface Background {
  /** Replaces the rules and tells open pages to fetch them again. */
  setRules(rules: MockRule[]): Promise<void>;
  getRules(): Promise<MockRule[]>;
  /** The most recent match reports, oldest first. */
  getMatches(): MatchReport[];
  /** Fills in `rules` only if none are stored yet, so a restarted worker keeps its rules. */
  seedRules(rules: MockRule[]): Promise<void>;
  /** A `chrome.runtime.onMessage` listener for the relays' messages. */
  handleMessage(message: ExtensionMessage, sendResponse: (response: unknown) => void): boolean;
}

export function createBackground(deps: BackgroundDeps): Background {
  const matches: MatchReport[] = [];

  const getRules = async () => {
    const { [RULES_KEY]: rules } = await deps.storage.get(RULES_KEY);
    return Array.isArray(rules) ? (rules as MockRule[]) : [];
  };

  const setRules = async (rules: MockRule[]) => {
    await deps.storage.set({ [RULES_KEY]: rules });
    await deps.notifyTabs({ type: "rules-updated" });
  };

  return {
    setRules,
    getRules,
    getMatches: () => [...matches],
    async seedRules(rules) {
      const { [RULES_KEY]: stored } = await deps.storage.get(RULES_KEY);
      if (stored === undefined) await setRules(rules);
    },
    handleMessage(message, sendResponse) {
      if (message.type === "get-rules") {
        getRules().then(sendResponse);
        return true; // the response is sent asynchronously
      }
      if (message.type === "match") {
        matches.push(message.match);
        if (matches.length > MAX_MATCHES) matches.shift();
      }
      return false;
    },
  };
}
