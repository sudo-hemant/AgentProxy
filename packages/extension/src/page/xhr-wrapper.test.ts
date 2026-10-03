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
let realAbort: Mock<XMLHttpRequest["abort"]>;
let originalSend: typeof XMLHttpRequest.prototype.send;
let originalAbort: typeof XMLHttpRequest.prototype.abort;
let store: RuleStore;
let reports: MatchReport[];
let uninstall: () => void;

beforeEach(() => {
  // Stand in for the network: the wrapper captures these as the real send and abort.
  originalSend = XMLHttpRequest.prototype.send;
  originalAbort = XMLHttpRequest.prototype.abort;
  realSend = vi.fn<XMLHttpRequest["send"]>();
  realAbort = vi.fn<XMLHttpRequest["abort"]>();
  XMLHttpRequest.prototype.send = realSend;
  XMLHttpRequest.prototype.abort = realAbort;
  store = createRuleStore();
  reports = [];
  uninstall = installXhrWrapper(XMLHttpRequest, store, (m) => reports.push(m), BASE);
});

afterEach(() => {
  uninstall();
  XMLHttpRequest.prototype.send = originalSend;
  XMLHttpRequest.prototype.abort = originalAbort;
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

    it("gives a Blob with the content type for responseType blob", async () => {
      const xhr = openXhr("GET", "/api/orders", "blob");
      await load(xhr);
      const blob = xhr.response as Blob;
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe("application/json");
      expect(await blob.text()).toBe('{"error":"boom"}');
    });

    it("gives the UTF-8 bytes for responseType arraybuffer", async () => {
      store.setRules([{ ...ordersRule, response: { status: 200, body: "café" } }]);
      const xhr = openXhr("GET", "/api/orders", "arraybuffer");
      await load(xhr);
      const buffer = xhr.response as ArrayBuffer;
      expect(buffer.byteLength).toBe(5);
      expect(new TextDecoder().decode(buffer)).toBe("café");
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

  describe("a synchronous request", () => {
    function openSync(url: string) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      return xhr;
    }

    it("is mocked before send returns when the rules are already here", () => {
      store.setRules([ordersRule]);
      const xhr = openSync("/api/orders");
      const events: string[] = [];
      xhr.addEventListener("readystatechange", () => events.push("readystatechange"));
      xhr.addEventListener("load", () => events.push("load"));
      xhr.addEventListener("loadend", () => events.push("loadend"));
      xhr.send();
      expect(xhr.status).toBe(500);
      expect(xhr.responseText).toBe('{"error":"boom"}');
      expect(events).toEqual(["readystatechange", "load", "loadend"]);
      expect(realSend).not.toHaveBeenCalled();
      expect(reports).toHaveLength(1);
    });

    it("goes out unmocked, without waiting, when the rules haven't arrived", () => {
      const xhr = openSync("/api/orders");
      xhr.send();
      expect(realSend).toHaveBeenCalledTimes(1);
      expect(reports).toEqual([]);
    });

    it("goes out through the real send, without waiting, when nothing matches", () => {
      store.setRules([ordersRule]);
      const xhr = openSync("/api/users");
      xhr.send();
      expect(realSend).toHaveBeenCalledTimes(1);
    });

    it("is only synchronous when open's third argument is false", async () => {
      store.setRules([ordersRule]);
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/orders", true);
      xhr.send();
      expect(xhr.status).toBe(0); // not answered yet
      await vi.waitFor(() => expect(xhr.status).toBe(500));
    });
  });

  describe("abort while waiting for the rules", () => {
    it("drops the request and fires the abort events", async () => {
      const xhr = openXhr("GET", "/api/orders");
      const events: string[] = [];
      xhr.onreadystatechange = () => events.push(`readystatechange:${xhr.readyState}`);
      xhr.onabort = () => events.push("abort");
      xhr.addEventListener("loadend", () => events.push("loadend"));
      xhr.addEventListener("load", () => events.push("load"));
      xhr.send();
      xhr.abort();
      expect(events).toEqual(["readystatechange:4", "abort", "loadend"]);
      expect(xhr.readyState).toBe(XMLHttpRequest.UNSENT);
      expect(xhr.status).toBe(0);

      store.setRules([ordersRule]);
      await store.ready;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).not.toContain("load");
      expect(realSend).not.toHaveBeenCalled();
      expect(realAbort).not.toHaveBeenCalled();
      expect(reports).toEqual([]);
    });

    it("drops an unmatched request too, instead of sending it later", async () => {
      const xhr = openXhr("GET", "/api/users");
      xhr.send();
      xhr.abort();
      store.setRules([ordersRule]);
      await store.ready;
      expect(realSend).not.toHaveBeenCalled();
    });
  });

  describe("abort once the request is out", () => {
    it("uses the real abort", async () => {
      store.setRules([ordersRule]);
      const xhr = openXhr("GET", "/api/users");
      xhr.send();
      await vi.waitFor(() => expect(realSend).toHaveBeenCalled());
      xhr.abort();
      expect(realAbort).toHaveBeenCalledTimes(1);
      expect(realAbort.mock.contexts[0]).toBe(xhr);
    });
  });

  describe("open again", () => {
    it("cancels a send still waiting for the rules, silently", async () => {
      const xhr = openXhr("GET", "/api/users");
      const aborts = vi.fn();
      xhr.onabort = aborts;
      xhr.send();
      xhr.open("GET", "/api/orders");
      const loaded = load(xhr);
      store.setRules([ordersRule]);
      await loaded;
      expect(realSend).not.toHaveBeenCalled(); // the cancelled /api/users never went out
      expect(aborts).not.toHaveBeenCalled();
      expect(reports.map((r) => r.url)).toEqual(["http://localhost:3000/api/orders"]);
    });

    it("clears an earlier mocked response so the XHR can be reused", async () => {
      store.setRules([ordersRule]);
      const xhr = openXhr("GET", "/api/orders");
      await load(xhr);
      expect(xhr.status).toBe(500);

      xhr.open("GET", "/api/users");
      expect(xhr.readyState).toBe(XMLHttpRequest.OPENED);
      expect(xhr.status).toBe(0);
      expect(Object.hasOwn(xhr, "getResponseHeader")).toBe(false);
    });
  });

  it("restores the real open, send and abort when uninstalled", () => {
    uninstall();
    expect(XMLHttpRequest.prototype.send).toBe(realSend);
    expect(XMLHttpRequest.prototype.abort).toBe(realAbort);
  });
});
