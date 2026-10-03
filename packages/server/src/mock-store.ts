import { isExpired, type MockRule } from "@agentproxy/shared";

/** The agent's mocks, as the server holds them. Expired mocks drop out on their own. */
export interface MockStore {
  /** Adds the mock, or replaces the one with the same id. Either way it becomes the newest. */
  set(rule: MockRule): { replaced: boolean };
  /** The live mocks, oldest first. The newest wins when several match a request. */
  list(): MockRule[];
  /** Removes the given mocks, or all of them when no ids are given. */
  clear(ids?: readonly string[]): { cleared: string[]; notFound: string[] };
}

export function createMockStore({ now = Date.now } = {}): MockStore {
  let rules: MockRule[] = [];

  const dropExpired = () => {
    const time = now();
    rules = rules.filter((rule) => !isExpired(rule, time));
  };

  return {
    set(rule) {
      dropExpired();
      const replaced = rules.some((r) => r.id === rule.id);
      rules = [...rules.filter((r) => r.id !== rule.id), rule];
      return { replaced };
    },

    list() {
      dropExpired();
      return [...rules];
    },

    clear(ids) {
      dropExpired();
      if (ids === undefined) {
        const cleared = rules.map((r) => r.id);
        rules = [];
        return { cleared, notFound: [] };
      }
      const wanted = new Set(ids);
      const cleared = rules.filter((r) => wanted.has(r.id)).map((r) => r.id);
      rules = rules.filter((r) => !wanted.has(r.id));
      return { cleared, notFound: [...wanted].filter((id) => !cleared.includes(id)) };
    },
  };
}
