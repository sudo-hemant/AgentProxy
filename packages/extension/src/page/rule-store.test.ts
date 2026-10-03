import type { MockRule } from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuleStore } from "./rule-store.js";

const rule = (id: string, expiresAt = Number.MAX_SAFE_INTEGER): MockRule => ({
  id,
  match: { url: { kind: "wildcard", value: "*/orders" } },
  response: { status: 200 },
  expiresAt,
});
const request = { method: "GET", url: "https://api.example.com/orders" };

/** Whether the promise has settled, after letting pending callbacks run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  return settled;
}

describe("createRuleStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("ready", () => {
    it("waits until the first rules arrive", async () => {
      const store = createRuleStore();
      expect(await isSettled(store.ready)).toBe(false);
      store.setRules([]);
      expect(await isSettled(store.ready)).toBe(true);
    });

    it("gives up waiting after the timeout", async () => {
      const store = createRuleStore({ timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(499);
      expect(await isSettled(store.ready)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await isSettled(store.ready)).toBe(true);
    });

    it("defaults to a 1 second timeout", async () => {
      const store = createRuleStore();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await isSettled(store.ready)).toBe(true);
    });
  });

  describe("hasRules", () => {
    it("is false until rules arrive, even after the timeout", async () => {
      const store = createRuleStore();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.hasRules()).toBe(false);
      store.setRules([]);
      expect(store.hasRules()).toBe(true);
    });
  });

  describe("find", () => {
    it("finds nothing before rules arrive", () => {
      expect(createRuleStore().find(request)).toBeUndefined();
    });

    it("finds the matching rule", () => {
      const store = createRuleStore();
      store.setRules([rule("a")]);
      expect(store.find(request)?.id).toBe("a");
    });

    it("uses only the latest rule list", () => {
      const store = createRuleStore();
      store.setRules([rule("a")]);
      store.setRules([rule("b")]);
      expect(store.find(request)?.id).toBe("b");
      store.setRules([]);
      expect(store.find(request)).toBeUndefined();
    });

    it("stops finding a rule once it expires", () => {
      vi.setSystemTime(1_000);
      const store = createRuleStore();
      store.setRules([rule("a", 2_000)]);
      expect(store.find(request)?.id).toBe("a");
      vi.setSystemTime(2_000);
      expect(store.find(request)).toBeUndefined();
    });
  });
});
