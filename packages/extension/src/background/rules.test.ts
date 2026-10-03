import type { ExtensionMessage, MatchReport, MockRule } from "@agentproxy/shared";
import { describe, expect, it, vi } from "vitest";
import { createBackground, MAX_MATCHES } from "./rules.js";

const rule = (id: string): MockRule => ({
  id,
  match: { url: { kind: "wildcard", value: "*/api/orders" } },
  response: { status: 200 },
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const match = (n: number): MatchReport => ({
  ruleId: "r",
  method: "GET",
  url: `http://localhost:3000/api/orders/${n}`,
  transport: "fetch",
});

/** A background over in-memory storage that records what it tells the tabs. */
function setup(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...initial };
  const notified: ExtensionMessage[] = [];
  const background = createBackground({
    storage: {
      get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
      set: async (items) => {
        Object.assign(stored, items);
      },
    },
    notifyTabs: async (message) => {
      notified.push(message);
    },
  });
  return { background, stored, notified };
}

describe("createBackground", () => {
  describe("rules", () => {
    it("starts with no rules", async () => {
      expect(await setup().background.getRules()).toEqual([]);
    });

    it("stores the rules and tells open tabs they changed", async () => {
      const { background, stored, notified } = setup();
      await background.setRules([rule("a")]);
      expect(await background.getRules()).toEqual([rule("a")]);
      expect(stored.rules).toEqual([rule("a")]);
      expect(notified).toEqual([{ type: "rules-updated" }]);
    });

    it("reads rules a previous worker stored", async () => {
      const { background } = setup({ rules: [rule("a")] });
      expect(await background.getRules()).toEqual([rule("a")]);
    });
  });

  describe("seedRules", () => {
    it("fills in rules when none are stored", async () => {
      const { background, notified } = setup();
      await background.seedRules([rule("demo")]);
      expect(await background.getRules()).toEqual([rule("demo")]);
      expect(notified).toHaveLength(1);
    });

    it("keeps stored rules, even an empty list", async () => {
      const { background, notified } = setup({ rules: [] });
      await background.seedRules([rule("demo")]);
      expect(await background.getRules()).toEqual([]);
      expect(notified).toEqual([]);
    });
  });

  describe("handleMessage", () => {
    it("answers get-rules asynchronously with the stored rules", async () => {
      const { background } = setup({ rules: [rule("a")] });
      const sendResponse = vi.fn();
      expect(background.handleMessage({ type: "get-rules" }, sendResponse)).toBe(true);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith([rule("a")]));
    });

    it("keeps match reports, oldest first", () => {
      const { background } = setup();
      const sendResponse = vi.fn();
      expect(background.handleMessage({ type: "match", match: match(1) }, sendResponse)).toBe(
        false,
      );
      background.handleMessage({ type: "match", match: match(2) }, sendResponse);
      expect(background.getMatches()).toEqual([match(1), match(2)]);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("keeps only the most recent match reports", () => {
      const { background } = setup();
      for (let n = 0; n < MAX_MATCHES + 5; n++) {
        background.handleMessage({ type: "match", match: match(n) }, () => {});
      }
      const kept = background.getMatches();
      expect(kept).toHaveLength(MAX_MATCHES);
      expect(kept[0]).toEqual(match(5));
    });

    it("ignores messages meant for the relays", () => {
      const { background } = setup();
      expect(background.handleMessage({ type: "rules-updated" }, () => {})).toBe(false);
    });
  });
});
