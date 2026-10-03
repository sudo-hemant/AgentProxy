import { describe, expect, it } from "vitest";
import { buildMockResponse } from "./mock-response.js";

describe("buildMockResponse", () => {
  it("keeps the status", () => {
    expect(buildMockResponse({ status: 500 }).status).toBe(500);
  });

  describe("body", () => {
    it("sends a string as-is", () => {
      expect(buildMockResponse({ status: 200, body: "plain text" }).body).toBe("plain text");
    });

    it("sends objects, arrays and other values as JSON", () => {
      expect(buildMockResponse({ status: 200, body: { orders: [] } }).body).toBe('{"orders":[]}');
      expect(buildMockResponse({ status: 200, body: [1, 2] }).body).toBe("[1,2]");
      expect(buildMockResponse({ status: 200, body: null }).body).toBe("null");
      expect(buildMockResponse({ status: 200, body: false }).body).toBe("false");
      expect(buildMockResponse({ status: 200, body: 0 }).body).toBe("0");
    });

    it("is empty when the rule gives none", () => {
      expect(buildMockResponse({ status: 200 }).body).toBe("");
    });

    it("is null for statuses that can't carry a body", () => {
      for (const status of [204, 205, 304]) {
        expect(buildMockResponse({ status, body: { ignored: true } }).body).toBeNull();
      }
    });
  });

  describe("headers", () => {
    it("defaults content-type to JSON", () => {
      expect(buildMockResponse({ status: 200 }).headers).toEqual({
        "content-type": "application/json",
      });
    });

    it("lower-cases header names", () => {
      const { headers } = buildMockResponse({ status: 200, headers: { "X-Request-Id": "abc" } });
      expect(headers["x-request-id"]).toBe("abc");
      expect(headers["X-Request-Id"]).toBeUndefined();
    });

    it("lets the rule override content-type in any case", () => {
      const { headers } = buildMockResponse({
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
      expect(headers).toEqual({ "content-type": "text/html" });
    });
  });
});
