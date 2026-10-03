import { describe, expect, it } from "vitest";
import { type MockInput, mockInputSchema, toMockRule } from "./mock-input.js";

const NOW = 1_000_000;
const newId = () => "generated";

/** Runs the input through the schema, as the MCP SDK does, then converts it. */
function convert(raw: Record<string, unknown>) {
  return toMockRule(mockInputSchema.parse(raw), NOW, newId);
}

/** The schema's error messages for an input, or [] if it passes. */
function schemaErrors(raw: Record<string, unknown>): string[] {
  const result = mockInputSchema.safeParse(raw);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("mockInputSchema", () => {
  it("needs only a url, and fills in the defaults", () => {
    expect(mockInputSchema.parse({ url: "*/api/orders" })).toEqual({
      url: "*/api/orders",
      match_type: "wildcard",
      status: 200,
      expires_in_seconds: 600,
    } satisfies MockInput);
  });

  it("rejects a missing or empty url", () => {
    expect(schemaErrors({})).not.toEqual([]);
    expect(schemaErrors({ url: "" })).not.toEqual([]);
  });

  it("accepts statuses 200 to 599 only", () => {
    expect(schemaErrors({ url: "*", status: 200 })).toEqual([]);
    expect(schemaErrors({ url: "*", status: 599 })).toEqual([]);
    for (const status of [199, 600, 0, 204.5]) {
      expect(schemaErrors({ url: "*", status })).not.toEqual([]);
    }
  });

  it("accepts expiries from 1 second to 24 hours", () => {
    expect(schemaErrors({ url: "*", expires_in_seconds: 86_400 })).toEqual([]);
    expect(schemaErrors({ url: "*", expires_in_seconds: 0 })).not.toEqual([]);
    expect(schemaErrors({ url: "*", expires_in_seconds: 86_401 })).not.toEqual([]);
  });

  it("accepts HTTP methods and *, nothing else", () => {
    expect(schemaErrors({ url: "*", method: "post" })).toEqual([]);
    expect(schemaErrors({ url: "*", method: "*" })).toEqual([]);
    expect(schemaErrors({ url: "*", method: "GET /x" })).toEqual([
      "method: must be an HTTP method like GET, or *",
    ]);
  });

  it("accepts simple ids only", () => {
    expect(schemaErrors({ url: "*", id: "orders-500.v2" })).toEqual([]);
    expect(schemaErrors({ url: "*", id: "has space" })).not.toEqual([]);
    expect(schemaErrors({ url: "*", id: "x".repeat(65) })).not.toEqual([]);
  });

  it("accepts string headers only", () => {
    expect(schemaErrors({ url: "*", headers: { "X-A": "1" } })).toEqual([]);
    expect(schemaErrors({ url: "*", headers: { "X-A": 1 } })).not.toEqual([]);
  });

  it("rejects an unknown match_type", () => {
    expect(schemaErrors({ url: "*", match_type: "glob" })).not.toEqual([]);
  });
});

describe("toMockRule", () => {
  it("builds a rule from the defaults", () => {
    expect(convert({ url: "*/api/orders" })).toEqual({
      ok: true,
      rule: {
        id: "generated",
        match: { url: { kind: "wildcard", value: "*/api/orders" }, method: undefined },
        response: { status: 200, body: undefined, headers: undefined },
        expiresAt: NOW + 600_000,
      },
    });
  });

  it("carries every field over", () => {
    const result = convert({
      id: "orders-500",
      url: "https://api.example.com/orders",
      match_type: "exact",
      method: "post",
      status: 500,
      body: { error: "boom" },
      headers: { "X-Debug": "1" },
      expires_in_seconds: 30,
    });
    expect(result).toEqual({
      ok: true,
      rule: {
        id: "orders-500",
        match: { url: { kind: "exact", value: "https://api.example.com/orders" }, method: "POST" },
        response: { status: 500, body: { error: "boom" }, headers: { "X-Debug": "1" } },
        expiresAt: NOW + 30_000,
      },
    });
  });

  it("passes regex flags into the matcher", () => {
    const result = convert({ url: "/orders/\\d+", match_type: "regex", regex_flags: "i" });
    expect(result.ok && result.rule.match.url).toEqual({
      kind: "regex",
      value: "/orders/\\d+",
      flags: "i",
    });
  });

  describe("explains a URL that could never match", () => {
    it("a relative exact URL", () => {
      expect(convert({ url: "/orders", match_type: "exact" })).toEqual({
        ok: false,
        errors: ["not an absolute URL: /orders"],
      });
    });

    it("a domain with a path", () => {
      expect(convert({ url: "example.com/api", match_type: "domain" }).ok).toBe(false);
    });

    it("an invalid regex", () => {
      const result = convert({ url: "(", match_type: "regex" });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.errors[0]).toMatch(/^invalid regex/);
    });

    it("regex flags without a regex", () => {
      expect(convert({ url: "*", regex_flags: "i" })).toEqual({
        ok: false,
        errors: ["regex_flags only applies when match_type is regex"],
      });
    });
  });
});
