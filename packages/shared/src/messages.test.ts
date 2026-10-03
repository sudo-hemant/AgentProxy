import { describe, expect, it } from "vitest";
import { isPageMessage, PAGE_CHANNEL } from "./messages.js";

describe("isPageMessage", () => {
  it("accepts each of our page message types", () => {
    expect(isPageMessage({ channel: PAGE_CHANNEL, type: "need-rules" })).toBe(true);
    expect(isPageMessage({ channel: PAGE_CHANNEL, type: "rules", rules: [] })).toBe(true);
    expect(
      isPageMessage({
        channel: PAGE_CHANNEL,
        type: "match",
        match: { ruleId: "r1", method: "GET", url: "https://x.io/", transport: "fetch" },
      }),
    ).toBe(true);
  });

  it("rejects messages without our channel tag", () => {
    expect(isPageMessage({ type: "need-rules" })).toBe(false);
    expect(isPageMessage({ channel: "someone-else", type: "need-rules" })).toBe(false);
  });

  it("rejects unknown message types", () => {
    expect(isPageMessage({ channel: PAGE_CHANNEL, type: "delete-everything" })).toBe(false);
    expect(isPageMessage({ channel: PAGE_CHANNEL })).toBe(false);
  });

  it("rejects values that are not objects", () => {
    expect(isPageMessage(null)).toBe(false);
    expect(isPageMessage(undefined)).toBe(false);
    expect(isPageMessage("need-rules")).toBe(false);
    expect(isPageMessage(42)).toBe(false);
  });
});
