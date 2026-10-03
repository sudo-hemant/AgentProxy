// @vitest-environment happy-dom
import type { MatchReport, MockRule } from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createRuleStore, type RuleStore } from "./rule-store.js";
import { installXhrWrapper } from "./xhr-wrapper.js";

const BASE = "http://localhost:3000/dashboard";

const ordersRule: MockRule = {
  id: "orders-500",
  match: { url: { kind: "wildcard", value: "*/api/orders" }, method: "GET" },
  response: { status: 500, body: { error: "boom" }, headers: { "X-Mocked": "yes" } },
  expiresAt: Number.MAX_SAFE_INTEGER,
};

let realSend: Mock<XMLHttpRequest["send"]>;
let originalSend: typeof XMLHttpRequest.prototype.send;
let store: RuleStore;
let reports: MatchReport[];
let uninstall: () => void;

beforeEach(() => {
  // Stands in for the network: the wrapper captures this as the real send.
  originalSend = XMLHttpRequest.prototype.send;
  realSend = vi.fn<XMLHttpRequest["send"]>();
  XMLHttpRequest.prototype.send = realSend;
  store = createRuleStore();
  reports = [];
  uninstall = installXhrWrapper(XMLHttpRequest, store, (m) => reports.push(m), BASE);
});

afterEach(() => {
  uninstall();
  XMLHttpRequest.prototype.send = originalSend;
});

/** Sends a request and resolves once its load event fires. */
function load(xhr: XMLHttpRequest, body?: string): Promise<void> {
  return new Promise((resolve) => {
    xhr.addEventListener("load", () => resolve());
    xhr.send(body);
  });
}

function openXhr(method: string, url: string, responseType: XMLHttpRequestResponseType = "") {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url);
  xhr.responseType = responseType;
  return xhr;
}

describe("installXhrWrapper", () => {
  describe("a matching async request", () => {
    beforeEach(() => store.setRules([ordersRule]));

    it("gets the mock's status, body and URL without touching the network", async () => {
      const xhr = openXhr("GET", "/api/orders");
      await load(xhr);
      expect(realSend).not.toHaveBeenCalled();
      expect(xhr.readyState).toBe(XMLHttpRequest.DONE);
      expect(xhr.status).toBe(500);
      expect(xhr.responseText).toBe('{"error":"boom"}');
      expect(xhr.response).toBe('{"error":"boom"}');
      expect(xhr.responseURL).toBe("http://localhost:3000/api/orders");
    });

    it("gets the mock's headers", async () => {
      const xhr = openXhr("GET", "/api/orders");
      await load(xhr);
      expect(xhr.getResponseHeader("X-Mocked")).toBe("yes");
      expect(xhr.getResponseHeader("content-type")).toBe("application/json");
      expect(xhr.getResponseHeader("missing")).toBeNull();
      expect(xhr.getAllResponseHeaders()).toBe(
        "content-type: application/json\r\nx-mocked: yes\r\n",
      );
    });

    it("parses the body for responseType json", async () => {
      const xhr = openXhr("GET", "/api/orders", "json");
      await load(xhr);
      expect(xhr.response).toEqual({ error: "boom" });
    });

    it("gives null for responseType json when the body isn't JSON", async () => {
      store.setRules([{ ...ordersRule, response: { status: 200, body: "not json" } }]);
      const xhr = openXhr("GET", "/api/orders", "json");
      await load(xhr);
      expect(xhr.response).toBeNull();
    });

    it("fires readystatechange, load and loadend, through on-handlers too", async () => {
      const xhr = openXhr("GET", "/api/orders");
      const events: string[] = [];
      xhr.onreadystatechange = () => events.push(`readystatechange:${xhr.readyState}`);
      xhr.onload = () => events.push("load");
      xhr.addEventListener("loadend", () => events.push("loadend"));
      xhr.send();
      expect(events).toEqual([]); // never synchronously inside send
      await vi.waitFor(() => expect(events).toContain("loadend"));
      expect(events).toEqual(["readystatechange:4", "load", "loadend"]);
    });

    it("is reported as a match", async () => {
      await load(openXhr("get", "/api/orders"));
      expect(reports).toEqual([
        {
          ruleId: "orders-500",
          method: "GET",
          url: "http://localhost:3000/api/orders",
          transport: "xhr",
        },
      ]);
    });
  });

  describe("a request that doesn't match", () => {
    it("is sent by the real send with its body", async () => {
      store.setRules([ordersRule]);
      const xhr = openXhr("POST", "/api/orders");
      xhr.send("payload");
      await vi.waitFor(() => expect(realSend).toHaveBeenCalledWith("payload"));
      expect(realSend.mock.contexts[0]).toBe(xhr);
      expect(reports).toEqual([]);
    });
  });

  describe("on page load", () => {
    it("waits for the first rules before deciding", async () => {
      const xhr = openXhr("GET", "/api/orders");
      const loaded = load(xhr);
      store.setRules([ordersRule]);
      await loaded;
      expect(xhr.status).toBe(500);
      expect(realSend).not.toHaveBeenCalled();
    });
  });

  it("restores the real open and send when uninstalled", () => {
    uninstall();
    expect(XMLHttpRequest.prototype.send).toBe(realSend);
  });
});
