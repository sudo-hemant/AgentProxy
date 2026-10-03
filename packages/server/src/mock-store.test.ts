import type { MockRule } from "@agentproxy/shared";
import { describe, expect, it } from "vitest";
import { createMockStore } from "./mock-store.js";

const rule = (id: string, expiresAt = 10_000, status = 200): MockRule => ({
  id,
  match: { url: { kind: "wildcard", value: `*/${id}` } },
  response: { status },
  expiresAt,
});

/** A store whose clock the test moves by hand. */
function setup() {
  let time = 0;
  const store = createMockStore({ now: () => time });
  return { store, setTime: (t: number) => (time = t) };
}

const ids = (rules: MockRule[]) => rules.map((r) => r.id);

describe("createMockStore", () => {
  it("starts empty", () => {
    expect(setup().store.list()).toEqual([]);
  });

  describe("set", () => {
    it("adds mocks, oldest first", () => {
      const { store } = setup();
      expect(store.set(rule("a"))).toEqual({ replaced: false });
      store.set(rule("b"));
      expect(ids(store.list())).toEqual(["a", "b"]);
    });

    it("replaces a mock with the same id, which becomes the newest", () => {
      const { store } = setup();
      store.set(rule("a"));
      store.set(rule("b"));
      expect(store.set(rule("a", 10_000, 500))).toEqual({ replaced: true });
      expect(store.list()).toEqual([rule("b"), rule("a", 10_000, 500)]);
    });

    it("doesn't count an expired mock with the same id as replaced", () => {
      const { store, setTime } = setup();
      store.set(rule("a", 1_000));
      setTime(1_000);
      expect(store.set(rule("a", 5_000))).toEqual({ replaced: false });
    });
  });

  describe("expiry", () => {
    it("drops mocks once they expire", () => {
      const { store, setTime } = setup();
      store.set(rule("short", 1_000));
      store.set(rule("long", 5_000));
      setTime(999);
      expect(ids(store.list())).toEqual(["short", "long"]);
      setTime(1_000);
      expect(ids(store.list())).toEqual(["long"]);
    });
  });

  describe("clear", () => {
    it("removes everything when given no ids", () => {
      const { store } = setup();
      store.set(rule("a"));
      store.set(rule("b"));
      expect(store.clear()).toEqual({ cleared: ["a", "b"], notFound: [] });
      expect(store.list()).toEqual([]);
    });

    it("removes only the given ids, and says which it didn't find", () => {
      const { store } = setup();
      store.set(rule("a"));
      store.set(rule("b"));
      expect(store.clear(["a", "missing"])).toEqual({ cleared: ["a"], notFound: ["missing"] });
      expect(ids(store.list())).toEqual(["b"]);
    });

    it("treats an expired mock as not found", () => {
      const { store, setTime } = setup();
      store.set(rule("a", 1_000));
      setTime(2_000);
      expect(store.clear(["a"])).toEqual({ cleared: [], notFound: ["a"] });
    });
  });

  it("hands out copies, so callers can't change the store by accident", () => {
    const { store } = setup();
    store.set(rule("a"));
    store.list().pop();
    expect(ids(store.list())).toEqual(["a"]);
  });
});
