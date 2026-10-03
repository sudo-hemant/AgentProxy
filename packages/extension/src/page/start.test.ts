// @vitest-environment happy-dom
import { type MockRule, PAGE_CHANNEL, type PageMessage } from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { startPageWrapper } from "./start.js";

const ordersRule: MockRule = {
  id: "orders-500",
  match: { url: { kind: "wildcard", value: "*/api/orders" } },
  response: { status: 500, body: { error: "boom" } },
  expiresAt: Number.MAX_SAFE_INTEGER,
};

let realFetch: Mock<typeof fetch>;
let posted: PageMessage[];
let stop: () => void;

beforeEach(() => {
  realFetch = vi.fn<typeof fetch>(async () => new Response("from network"));
  window.fetch = realFetch;
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message as PageMessage);
  });
  stop = startPageWrapper(window);
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
});

/** Delivers a message as if posted on this window, from `origin`. */
function deliver(
  data: unknown,
  { origin = window.location.origin, source = window as unknown } = {},
) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
}

const rulesMessage = (rules: MockRule[]) => ({ channel: PAGE_CHANNEL, type: "rules", rules });

describe("startPageWrapper", () => {
  it("asks for the rules on start", () => {
    expect(posted).toEqual([{ channel: PAGE_CHANNEL, type: "need-rules" }]);
  });

  it("mocks fetch with the rules it receives", async () => {
    deliver(rulesMessage([ordersRule]));
    const response = await window.fetch("/api/orders");
    expect(response.status).toBe(500);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("mocks XMLHttpRequest with the rules it receives", async () => {
    deliver(rulesMessage([ordersRule]));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/orders");
    await new Promise<void>((resolve) => {
      xhr.onload = () => resolve();
      xhr.send();
    });
    expect(xhr.status).toBe(500);
  });

  it("reports each mocked request to the relay", async () => {
    deliver(rulesMessage([ordersRule]));
    await window.fetch("/api/orders");
    expect(posted.at(-1)).toEqual({
      channel: PAGE_CHANNEL,
      type: "match",
      match: {
        ruleId: "orders-500",
        method: "GET",
        url: `${window.location.origin}/api/orders`,
        transport: "fetch",
      },
    });
  });

  it("applies a new rule list without a reload", async () => {
    deliver(rulesMessage([ordersRule]));
    deliver(rulesMessage([]));
    await window.fetch("/api/orders");
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it("calls the real fetch on the window, keeping its arguments", async () => {
    deliver(rulesMessage([]));
    const init = { headers: { Authorization: "Bearer secret" } };
    await window.fetch("/api/users", init);
    expect(realFetch).toHaveBeenCalledWith("/api/users", init);
    expect(realFetch.mock.contexts[0]).toBe(window);
  });

  describe("ignores rules", () => {
    // Restart under fake timers: with the bad message ignored, fetch waits out the rules timeout.
    beforeEach(() => {
      stop();
      vi.useFakeTimers();
      stop = startPageWrapper(window);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Fetches /api/orders once the rules timeout has passed with no accepted rules. */
    async function fetchAfterTimeout() {
      const pending = window.fetch("/api/orders");
      await vi.advanceTimersByTimeAsync(1000);
      return pending;
    }

    it("from another origin", async () => {
      deliver(rulesMessage([ordersRule]), { origin: "https://evil.example" });
      await fetchAfterTimeout();
      expect(realFetch).toHaveBeenCalled();
    });

    it("from another window", async () => {
      deliver(rulesMessage([ordersRule]), { source: {} });
      await fetchAfterTimeout();
      expect(realFetch).toHaveBeenCalled();
    });

    it("without our channel tag", async () => {
      deliver({ type: "rules", rules: [ordersRule] });
      await fetchAfterTimeout();
      expect(realFetch).toHaveBeenCalled();
    });

    it("but accepts the same rules from this window and origin", async () => {
      deliver(rulesMessage([ordersRule]));
      await fetchAfterTimeout();
      expect(realFetch).not.toHaveBeenCalled();
    });
  });

  it("restores fetch when stopped", () => {
    stop();
    expect(window.fetch).toBe(realFetch);
  });
});
