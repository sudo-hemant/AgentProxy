import type { MatchReport, MockRule } from "@agentproxy/shared";
import { describe, expect, it, vi } from "vitest";
import { createMockFetch } from "./fetch-wrapper.js";
import { createRuleStore } from "./rule-store.js";

const BASE = "http://localhost:3000/dashboard";

const ordersRule: MockRule = {
  id: "orders-500",
  match: { url: { kind: "wildcard", value: "*/api/orders" }, method: "GET" },
  response: { status: 500, body: { error: "boom" }, headers: { "X-Mocked": "yes" } },
  expiresAt: Number.MAX_SAFE_INTEGER,
};

function setup(rules: MockRule[] | undefined = [ordersRule]) {
  const realFetch = vi.fn<typeof fetch>(async () => new Response("from network"));
  const store = createRuleStore();
  if (rules) store.setRules(rules);
  const reports: MatchReport[] = [];
  const mockFetch = createMockFetch(realFetch, store, (m) => reports.push(m), BASE);
  return { realFetch, store, reports, mockFetch };
}

describe("createMockFetch", () => {
  describe("a matching request", () => {
    it("gets the mock's status, body and headers without touching the network", async () => {
      const { realFetch, mockFetch } = setup();
      const response = await mockFetch("https://api.example.com/api/orders");
      expect(realFetch).not.toHaveBeenCalled();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "boom" });
      expect(response.headers.get("x-mocked")).toBe("yes");
      expect(response.headers.get("content-type")).toBe("application/json");
    });

    it("has the request's URL on the response", async () => {
      const { mockFetch } = setup();
      const response = await mockFetch("/api/orders");
      expect(response.url).toBe("http://localhost:3000/api/orders");
    });

    it("is reported as a match", async () => {
      const { mockFetch, reports } = setup();
      await mockFetch("/api/orders");
      expect(reports).toEqual([
        {
          ruleId: "orders-500",
          method: "GET",
          url: "http://localhost:3000/api/orders",
          transport: "fetch",
        },
      ]);
    });

    it("can be given as a URL object or a Request", async () => {
      const { realFetch, mockFetch } = setup();
      await mockFetch(new URL("https://api.example.com/api/orders"));
      await mockFetch(new Request("https://api.example.com/api/orders"));
      expect(realFetch).not.toHaveBeenCalled();
    });

    it("gets no body for a 204", async () => {
      const { mockFetch } = setup([{ ...ordersRule, response: { status: 204 } }]);
      const response = await mockFetch("/api/orders");
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    it("rejects like a real fetch when its signal is already aborted", async () => {
      const { mockFetch, reports } = setup();
      const controller = new AbortController();
      controller.abort();
      await expect(mockFetch("/api/orders", { signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(reports).toEqual([]);
    });
  });

  describe("a request that doesn't match", () => {
    it("goes to the real fetch with the caller's exact arguments", async () => {
      const { realFetch, mockFetch, reports } = setup();
      const init = { headers: { Authorization: "Bearer secret" } };
      const response = await mockFetch("/api/users", init);
      expect(realFetch).toHaveBeenCalledWith("/api/users", init);
      expect(realFetch.mock.calls[0]?.[1]).toBe(init);
      expect(await response.text()).toBe("from network");
      expect(reports).toEqual([]);
    });

    it("is matched on the method given in init or on the Request", async () => {
      const { realFetch, mockFetch } = setup();
      await mockFetch("/api/orders", { method: "POST" });
      const request = new Request("https://api.example.com/api/orders", { method: "POST" });
      await mockFetch(request);
      expect(realFetch).toHaveBeenCalledTimes(2);
      expect(realFetch.mock.calls[1]?.[0]).toBe(request);
    });

    it("goes to the real fetch when its URL is invalid", async () => {
      const { realFetch, mockFetch } = setup();
      await mockFetch("http://[bad");
      expect(realFetch).toHaveBeenCalledWith("http://[bad", undefined);
    });
  });

  describe("on page load", () => {
    it("waits for the first rules before deciding", async () => {
      const { realFetch, store, mockFetch } = setup(undefined);
      const pending = mockFetch("/api/orders");
      store.setRules([ordersRule]);
      expect((await pending).status).toBe(500);
      expect(realFetch).not.toHaveBeenCalled();
    });
  });
});
