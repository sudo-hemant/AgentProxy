import { describe, expect, it } from "vitest";
import {
  findMatchingRule,
  isExpired,
  matchesMethod,
  matchesRequest,
  matchesUrl,
  validateUrlMatcher,
} from "./matcher.js";
import type { MockRule, UrlMatcher } from "./rule.js";

const exact = (value: string): UrlMatcher => ({ kind: "exact", value });
const wildcard = (value: string): UrlMatcher => ({ kind: "wildcard", value });
const domain = (value: string): UrlMatcher => ({ kind: "domain", value });
const regex = (value: string, flags?: string): UrlMatcher => ({ kind: "regex", value, flags });

describe("exact", () => {
  const rule = exact("https://api.example.com/orders");

  it("matches the same URL", () => {
    expect(matchesUrl(rule, "https://api.example.com/orders")).toBe(true);
  });

  it("does not match another path, host, scheme or port", () => {
    expect(matchesUrl(rule, "https://api.example.com/orders/1")).toBe(false);
    expect(matchesUrl(rule, "https://api.example.com/order")).toBe(false);
    expect(matchesUrl(rule, "https://other.example.com/orders")).toBe(false);
    expect(matchesUrl(rule, "http://api.example.com/orders")).toBe(false);
    expect(matchesUrl(rule, "https://api.example.com:8443/orders")).toBe(false);
  });

  it("treats a trailing slash as optional on both sides", () => {
    expect(matchesUrl(rule, "https://api.example.com/orders/")).toBe(true);
    expect(
      matchesUrl(exact("https://api.example.com/orders/"), "https://api.example.com/orders"),
    ).toBe(true);
  });

  it("matches any query when the rule has none", () => {
    expect(matchesUrl(rule, "https://api.example.com/orders?page=2")).toBe(true);
  });

  it("requires the same query parameters, in any order, when the rule has some", () => {
    const withQuery = exact("https://api.example.com/orders?page=2&size=10");
    expect(matchesUrl(withQuery, "https://api.example.com/orders?size=10&page=2")).toBe(true);
    expect(matchesUrl(withQuery, "https://api.example.com/orders?page=2")).toBe(false);
    expect(matchesUrl(withQuery, "https://api.example.com/orders?page=3&size=10")).toBe(false);
    expect(matchesUrl(withQuery, "https://api.example.com/orders?page=2&size=10&x=1")).toBe(false);
    expect(matchesUrl(withQuery, "https://api.example.com/orders")).toBe(false);
  });

  it("ignores the hash, host case and default ports", () => {
    expect(matchesUrl(rule, "https://api.example.com/orders#top")).toBe(true);
    expect(matchesUrl(rule, "https://API.Example.com/orders")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com:443/orders")).toBe(true);
  });

  it("keeps path case significant", () => {
    expect(matchesUrl(rule, "https://api.example.com/Orders")).toBe(false);
  });

  it("never matches when the rule URL is not absolute", () => {
    expect(matchesUrl(exact("/orders"), "https://api.example.com/orders")).toBe(false);
  });
});

describe("wildcard", () => {
  it("matches any characters, slashes included", () => {
    const rule = wildcard("https://api.example.com/orders/*");
    expect(matchesUrl(rule, "https://api.example.com/orders/1")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/orders/1/items")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/users/1")).toBe(false);
  });

  it("can match any host or scheme", () => {
    const rule = wildcard("*/api/orders");
    expect(matchesUrl(rule, "http://localhost:3000/api/orders")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/api/orders")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/api/orders/1")).toBe(false);
  });

  it("applies a pattern without a scheme to every scheme", () => {
    const rule = wildcard("api.example.com/orders");
    expect(matchesUrl(rule, "https://api.example.com/orders")).toBe(true);
    expect(matchesUrl(rule, "http://api.example.com/orders")).toBe(true);
  });

  it("matches subdomains only when the pattern says so", () => {
    expect(matchesUrl(wildcard("https://*.example.com/*"), "https://api.example.com/x")).toBe(true);
    expect(matchesUrl(wildcard("https://*.example.com/*"), "https://example.com/x")).toBe(false);
    expect(matchesUrl(wildcard("https://example.com/*"), "https://api.example.com/x")).toBe(false);
  });

  it("ignores the query when the pattern has none", () => {
    const rule = wildcard("https://api.example.com/orders");
    expect(matchesUrl(rule, "https://api.example.com/orders?page=2")).toBe(true);
  });

  it("matches the query when the pattern has one", () => {
    const rule = wildcard("https://api.example.com/orders?page=*");
    expect(matchesUrl(rule, "https://api.example.com/orders?page=2")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/orders")).toBe(false);
    expect(matchesUrl(rule, "https://api.example.com/orders?size=10")).toBe(false);
  });

  it("treats a trailing slash as optional, including on the root", () => {
    expect(
      matchesUrl(wildcard("https://api.example.com/orders/"), "https://api.example.com/orders"),
    ).toBe(true);
    expect(
      matchesUrl(wildcard("https://api.example.com/orders"), "https://api.example.com/orders/"),
    ).toBe(true);
    expect(matchesUrl(wildcard("https://api.example.com/"), "https://api.example.com")).toBe(true);
    expect(matchesUrl(wildcard("https://api.example.com"), "https://api.example.com/")).toBe(true);
  });

  it("treats regex characters in the pattern literally", () => {
    const rule = wildcard("https://api.example.com/v1.0/(orders)+");
    expect(matchesUrl(rule, "https://api.example.com/v1.0/(orders)+")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/v1x0/orders")).toBe(false);
  });
});

describe("domain", () => {
  it("matches the domain and its subdomains", () => {
    const rule = domain("example.com");
    expect(matchesUrl(rule, "https://example.com/orders")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/orders")).toBe(true);
    expect(matchesUrl(rule, "https://a.b.example.com/orders")).toBe(true);
  });

  it("does not match a host that merely ends with the same letters", () => {
    expect(matchesUrl(domain("example.com"), "https://badexample.com/")).toBe(false);
    expect(matchesUrl(domain("example.com"), "https://example.com.evil.io/")).toBe(false);
  });

  it("does not match the parent of a subdomain rule", () => {
    expect(matchesUrl(domain("api.example.com"), "https://example.com/")).toBe(false);
  });

  it("ignores scheme, port, case and a leading dot or *.", () => {
    expect(matchesUrl(domain("Example.COM"), "http://api.example.com:8080/x")).toBe(true);
    expect(matchesUrl(domain("*.example.com"), "https://api.example.com/")).toBe(true);
    expect(matchesUrl(domain(".example.com"), "https://example.com/")).toBe(true);
  });

  it("matches localhost", () => {
    expect(matchesUrl(domain("localhost"), "http://localhost:3000/api")).toBe(true);
  });
});

describe("regex", () => {
  it("tests the full URL, query included", () => {
    expect(matchesUrl(regex("/orders/\\d+$"), "https://api.example.com/orders/42")).toBe(true);
    expect(matchesUrl(regex("/orders/\\d+$"), "https://api.example.com/orders/abc")).toBe(false);
    expect(matchesUrl(regex("[?&]page=2"), "https://api.example.com/orders?page=2")).toBe(true);
  });

  it("applies flags", () => {
    expect(matchesUrl(regex("/ORDERS"), "https://api.example.com/orders")).toBe(false);
    expect(matchesUrl(regex("/ORDERS", "i"), "https://api.example.com/orders")).toBe(true);
  });

  it("gives the same answer on repeated calls with the g flag", () => {
    const rule = regex("orders", "g");
    expect(matchesUrl(rule, "https://api.example.com/orders")).toBe(true);
    expect(matchesUrl(rule, "https://api.example.com/orders")).toBe(true);
  });

  it("never matches when the regex is invalid", () => {
    expect(matchesUrl(regex("("), "https://api.example.com/(")).toBe(false);
  });
});

describe("matchesUrl with a bad request URL", () => {
  it("never matches a relative request URL", () => {
    expect(matchesUrl(wildcard("*"), "/orders")).toBe(false);
  });
});

describe("method", () => {
  it("matches any method when omitted or *", () => {
    expect(matchesMethod(undefined, "POST")).toBe(true);
    expect(matchesMethod("*", "DELETE")).toBe(true);
  });

  it("compares case-insensitively", () => {
    expect(matchesMethod("get", "GET")).toBe(true);
    expect(matchesMethod("GET", "post")).toBe(false);
  });

  it("needs both method and URL to match", () => {
    const match = { url: wildcard("*/orders"), method: "POST" };
    expect(matchesRequest(match, { method: "POST", url: "https://x.io/orders" })).toBe(true);
    expect(matchesRequest(match, { method: "GET", url: "https://x.io/orders" })).toBe(false);
    expect(matchesRequest(match, { method: "POST", url: "https://x.io/users" })).toBe(false);
  });
});

describe("findMatchingRule", () => {
  const rule = (id: string, url: UrlMatcher, expiresAt = 1_000): MockRule => ({
    id,
    match: { url },
    response: { status: 200 },
    expiresAt,
  });
  const request = { method: "GET", url: "https://api.example.com/orders" };

  it("returns the most recently added matching rule", () => {
    const rules = [
      rule("a", domain("example.com")),
      rule("b", wildcard("*/orders")),
      rule("c", domain("other.io")),
    ];
    expect(findMatchingRule(rules, request, 0)?.id).toBe("b");
  });

  it("skips expired rules", () => {
    const rules = [rule("a", domain("example.com"), 1_000), rule("b", wildcard("*/orders"), 500)];
    expect(findMatchingRule(rules, request, 500)?.id).toBe("a");
    expect(findMatchingRule(rules, request, 1_000)).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(findMatchingRule([], request, 0)).toBeUndefined();
    expect(findMatchingRule([rule("a", domain("other.io"))], request, 0)).toBeUndefined();
  });

  it("treats a rule as expired from its expiry time on", () => {
    expect(isExpired(rule("a", domain("x.io"), 1_000), 999)).toBe(false);
    expect(isExpired(rule("a", domain("x.io"), 1_000), 1_000)).toBe(true);
  });
});

describe("validateUrlMatcher", () => {
  it("accepts usable matchers", () => {
    expect(validateUrlMatcher(exact("https://api.example.com/orders"))).toEqual([]);
    expect(validateUrlMatcher(wildcard("*/orders"))).toEqual([]);
    expect(validateUrlMatcher(domain("*.example.com"))).toEqual([]);
    expect(validateUrlMatcher(regex("orders/\\d+", "i"))).toEqual([]);
  });

  it("rejects empty values", () => {
    expect(validateUrlMatcher(wildcard("  "))).toHaveLength(1);
  });

  it("rejects a relative exact URL", () => {
    expect(validateUrlMatcher(exact("/orders"))).toHaveLength(1);
  });

  it("rejects a domain with a scheme, port or path", () => {
    expect(validateUrlMatcher(domain("https://example.com"))).toHaveLength(1);
    expect(validateUrlMatcher(domain("example.com:8080"))).toHaveLength(1);
    expect(validateUrlMatcher(domain("example.com/api"))).toHaveLength(1);
  });

  it("rejects an invalid regex or flags", () => {
    expect(validateUrlMatcher(regex("("))).toHaveLength(1);
    expect(validateUrlMatcher(regex("a", "z"))).toHaveLength(1);
  });
});
