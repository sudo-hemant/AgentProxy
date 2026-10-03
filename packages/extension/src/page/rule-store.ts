import { findMatchingRule, type MockRule, type RequestInfo } from "@agentproxy/shared";

/** The rules the page wrapper currently applies. */
export interface RuleStore {
  /**
   * Resolves when the first rules arrive, or after the timeout if they never do, so the app is
   * never held up for long. Never rejects. Requests wait on it so mocks apply during page load.
   */
  readonly ready: Promise<void>;
  /** Whether any rule list has arrived yet. */
  hasRules(): boolean;
  /** Replaces the current rules with a new full list. */
  setRules(rules: readonly MockRule[]): void;
  /** The rule that answers this request now, if any. */
  find(request: RequestInfo): MockRule | undefined;
}

export const DEFAULT_RULES_TIMEOUT_MS = 1000;

export function createRuleStore({ timeoutMs = DEFAULT_RULES_TIMEOUT_MS } = {}): RuleStore {
  let rules: readonly MockRule[] | undefined;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  setTimeout(markReady, timeoutMs);

  return {
    ready,
    hasRules: () => rules !== undefined,
    setRules(next) {
      rules = next;
      markReady();
    },
    find: (request) => (rules ? findMatchingRule(rules, request, Date.now()) : undefined),
  };
}
