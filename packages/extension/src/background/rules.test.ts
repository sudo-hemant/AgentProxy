import type { ExtensionMessage, MatchReport, MockRule } from "@agentproxy/shared";
import { describe, expect, it, vi } from "vitest";
import { createBackground } from "./rules.js";

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
  const forwarded: MatchReport[] = [];
  const background = createBackground({
    onMatch: (match) => forwarded.push(match),
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
  return { background, stored, notified, forwarded };
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

  describe("handleMessage", () => {
    it("answers get-rules asynchronously with the stored rules", async () => {
      const { background } = setup({ rules: [rule("a")] });
      const sendResponse = vi.fn();
      expect(background.handleMessage({ type: "get-rules" }, sendResponse)).toBe(true);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith([rule("a")]));
    });

    it("passes each match report on, in order, without answering", () => {
      const { background, forwarded } = setup();
      const sendResponse = vi.fn();
      expect(background.handleMessage({ type: "match", match: match(1) }, sendResponse)).toBe(
        false,
      );
      background.handleMessage({ type: "match", match: match(2) }, sendResponse);
      expect(forwarded).toEqual([match(1), match(2)]);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("ignores messages meant for the relays", () => {
      const { background } = setup();
      expect(background.handleMessage({ type: "rules-updated" }, () => {})).toBe(false);
    });
  });
});
