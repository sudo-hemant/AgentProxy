// @vitest-environment happy-dom
import {
  type ExtensionMessage,
  type MatchReport,
  type MockRule,
  PAGE_CHANNEL,
  type PageMessage,
} from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RelayRuntime, startRelay as start } from "./start.js";

/** Starts a relay that is stopped after the test. */
const startRelay = (win: Window, runtime: RelayRuntime) => stops.push(start(win, runtime));

const ordersRule: MockRule = {
  id: "orders-500",
  match: { url: { kind: "wildcard", value: "*/api/orders" } },
  response: { status: 500 },
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const match: MatchReport = {
  ruleId: "orders-500",
  method: "GET",
  url: "http://localhost:3000/api/orders",
  transport: "fetch",
};

/** A fake chrome.runtime whose background answers get-rules with `rules`. */
function fakeRuntime(rules: () => unknown = () => [ordersRule]) {
  const sent: ExtensionMessage[] = [];
  let listener: ((message: ExtensionMessage) => void) | undefined;
  const runtime: RelayRuntime = {
    sendMessage: vi.fn(async (message: ExtensionMessage) => {
      sent.push(message);
      return message.type === "get-rules" ? rules() : undefined;
    }),
    onMessage: { addListener: (l) => (listener = l) },
  };
  return { runtime, sent, fromBackground: (m: ExtensionMessage) => listener?.(m) };
}

let posted: PageMessage[];
const stops: Array<() => void> = [];

beforeEach(() => {
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message as PageMessage);
  });
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
});

/** Delivers a message as if the page posted it on this window. */
function fromPage(
  data: unknown,
  { origin = window.location.origin, source = window as unknown } = {},
) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const rulesPosted = () => posted.filter((m) => m.type === "rules");

describe("startRelay", () => {
  it("posts the background's rules into the page on start", async () => {
    startRelay(window, fakeRuntime().runtime);
    await flush();
    expect(posted).toEqual([{ channel: PAGE_CHANNEL, type: "rules", rules: [ordersRule] }]);
  });

  it("posts the rules again when the page asks for them", async () => {
    const { runtime, sent } = fakeRuntime();
    startRelay(window, runtime);
    await flush();
    fromPage({ channel: PAGE_CHANNEL, type: "need-rules" });
    await flush();
    expect(sent.filter((m) => m.type === "get-rules")).toHaveLength(2);
    expect(rulesPosted()).toHaveLength(2);
  });

  it("posts the new rules when the background says they changed", async () => {
    let current: MockRule[] = [ordersRule];
    const { runtime, fromBackground } = fakeRuntime(() => current);
    startRelay(window, runtime);
    await flush();
    current = [];
    fromBackground({ type: "rules-updated" });
    await flush();
    expect(rulesPosted().at(-1)).toEqual({ channel: PAGE_CHANNEL, type: "rules", rules: [] });
  });

  it("forwards the page's match reports to the background", async () => {
    const { runtime, sent } = fakeRuntime();
    startRelay(window, runtime);
    fromPage({ channel: PAGE_CHANNEL, type: "match", match });
    expect(sent).toContainEqual({ type: "match", match });
  });

  it("posts only the newest rules when replies arrive out of order", async () => {
    const replies: Array<(rules: MockRule[]) => void> = [];
    const runtime: RelayRuntime = {
      sendMessage: () => new Promise((resolve) => replies.push(resolve)),
      onMessage: { addListener: () => {} },
    };
    startRelay(window, runtime); // request 1
    fromPage({ channel: PAGE_CHANNEL, type: "need-rules" }); // request 2
    replies[1]?.([]); // the newer reply arrives first
    replies[0]?.([ordersRule]);
    await flush();
    expect(rulesPosted()).toEqual([{ channel: PAGE_CHANNEL, type: "rules", rules: [] }]);
  });

  it("posts an empty list when the background's reply isn't a list", async () => {
    startRelay(window, fakeRuntime(() => undefined).runtime);
    await flush();
    expect(rulesPosted()).toEqual([{ channel: PAGE_CHANNEL, type: "rules", rules: [] }]);
  });

  it("posts nothing when the extension can't be reached", async () => {
    const runtime: RelayRuntime = {
      sendMessage: () => Promise.reject(new Error("Extension context invalidated.")),
      onMessage: { addListener: () => {} },
    };
    startRelay(window, runtime);
    fromPage({ channel: PAGE_CHANNEL, type: "match", match });
    await flush();
    expect(posted).toEqual([]);
  });

  describe("ignores page messages", () => {
    it("from another origin", () => {
      const { runtime, sent } = fakeRuntime();
      startRelay(window, runtime);
      fromPage({ channel: PAGE_CHANNEL, type: "match", match }, { origin: "https://evil.example" });
      expect(sent.filter((m) => m.type === "match")).toEqual([]);
    });

    it("from another window", () => {
      const { runtime, sent } = fakeRuntime();
      startRelay(window, runtime);
      fromPage({ channel: PAGE_CHANNEL, type: "match", match }, { source: {} });
      expect(sent.filter((m) => m.type === "match")).toEqual([]);
    });

    it("without our channel tag", () => {
      const { runtime, sent } = fakeRuntime();
      startRelay(window, runtime);
      fromPage({ type: "match", match });
      expect(sent.filter((m) => m.type === "match")).toEqual([]);
    });
  });
});
