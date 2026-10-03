import type { ExtensionMessage, MatchReport, MockRule } from "@agentproxy/shared";

const RULES_KEY = "rules";

/** The browser APIs the background needs, so tests can pass fakes. */
export interface BackgroundDeps {
  /** `chrome.storage.session`: survives the service worker being stopped, not a browser restart. */
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** Sends a message to the relays in every open tab the extension covers. */
  notifyTabs(message: ExtensionMessage): Promise<void>;
  /** Called for every match report a relay forwards. */
  onMatch(match: MatchReport): void;
}

export interface Background {
  /** Replaces the rules and tells open pages to fetch them again. */
  setRules(rules: MockRule[]): Promise<void>;
  getRules(): Promise<MockRule[]>;
  /** A `chrome.runtime.onMessage` listener for the relays' messages. */
  handleMessage(message: ExtensionMessage, sendResponse: (response: unknown) => void): boolean;
}

export function createBackground(deps: BackgroundDeps): Background {
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
    handleMessage(message, sendResponse) {
      if (message.type === "get-rules") {
        getRules().then(sendResponse);
        return true; // the response is sent asynchronously
      }
      if (message.type === "match") {
        deps.onMatch(message.match);
      }
      return false;
    },
  };
}
