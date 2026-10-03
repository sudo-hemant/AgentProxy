import type { MockRule, RequestInfo, RuleMatch, UrlMatcher } from "./rule.js";

// Query strings: a rule that names no query matches the URL with any query. A rule that names a
// query only matches requests with exactly those parameters, in any order.
// Trailing slashes: `/orders` and `/orders/` are the same path.

/** Whether the rule's URL and method both match the request. Expiry is not checked here. */
export function matchesRequest(match: RuleMatch, request: RequestInfo): boolean {
  return matchesMethod(match.method, request.method) && matchesUrl(match.url, request.url);
}

export function matchesMethod(ruleMethod: string | undefined, requestMethod: string): boolean {
  if (ruleMethod === undefined || ruleMethod === "*") return true;
  return ruleMethod.toUpperCase() === requestMethod.toUpperCase();
}

export function matchesUrl(matcher: UrlMatcher, requestUrl: string): boolean {
  const url = parseUrl(requestUrl);
  if (!url) return false;
  switch (matcher.kind) {
    case "exact":
      return matchesExact(matcher.value, url);
    case "wildcard":
      return matchesWildcard(matcher.value, url);
    case "domain":
      return matchesDomain(matcher.value, url);
    case "regex":
      return compileRegex(matcher.value, matcher.flags)?.test(url.href) ?? false;
  }
}

export function isExpired(rule: MockRule, now: number): boolean {
  return now >= rule.expiresAt;
}

/** The rule that answers this request: the most recently added live rule that matches it. */
export function findMatchingRule(
  rules: readonly MockRule[],
  request: RequestInfo,
  now: number,
): MockRule | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i] as MockRule;
    if (!isExpired(rule, now) && matchesRequest(rule.match, request)) return rule;
  }
  return undefined;
}

/** Problems that would stop a URL matcher from ever matching. Empty when it is usable. */
export function validateUrlMatcher(matcher: UrlMatcher): string[] {
  if (matcher.value.trim() === "") return ["URL matcher value must not be empty"];
  switch (matcher.kind) {
    case "exact":
      return parseUrl(matcher.value) ? [] : [`not an absolute URL: ${matcher.value}`];
    case "wildcard":
      return [];
    case "domain":
      return /^[\w.-]+$/.test(normalizeDomain(matcher.value))
        ? []
        : [`not a hostname (no scheme, port or path): ${matcher.value}`];
    case "regex":
      try {
        new RegExp(matcher.value, matcher.flags);
        return [];
      } catch (error) {
        return [`invalid regex: ${(error as Error).message}`];
      }
  }
}

function matchesExact(ruleUrl: string, url: URL): boolean {
  const expected = parseUrl(ruleUrl);
  if (!expected) return false;
  if (expected.origin !== url.origin) return false;
  if (trimTrailingSlash(expected.pathname) !== trimTrailingSlash(url.pathname)) return false;
  return expected.search === "" || sameQuery(expected.searchParams, url.searchParams);
}

function matchesWildcard(pattern: string, url: URL): boolean {
  // A pattern without a scheme applies to every scheme: `api.example.com/*`.
  const full = pattern.includes("://") ? pattern : `*://${pattern}`;
  const [patternBase = "", patternQuery] = splitQuery(full);
  const target = trimTrailingSlash(url.origin + url.pathname) + (patternQuery ? url.search : "");
  const source = trimTrailingSlash(patternBase) + (patternQuery ? `?${patternQuery}` : "");
  return globToRegex(source).test(target);
}

function matchesDomain(domain: string, url: URL): boolean {
  const expected = normalizeDomain(domain);
  return url.hostname === expected || url.hostname.endsWith(`.${expected}`);
}

/** Accepts `example.com`, `.example.com` and `*.example.com`, in any case. */
function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^\*?\./, "");
}

function sameQuery(expected: URLSearchParams, actual: URLSearchParams): boolean {
  const sorted = (params: URLSearchParams) => [...params].map(([k, v]) => `${k}=${v}`).sort();
  const a = sorted(expected);
  const b = sorted(actual);
  return a.length === b.length && a.every((pair, i) => pair === b[i]);
}

function splitQuery(value: string): [string, string | undefined] {
  const index = value.indexOf("?");
  return index === -1 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const globCache = new Map<string, RegExp>();

function globToRegex(glob: string): RegExp {
  let regex = globCache.get(glob);
  if (!regex) {
    const escaped = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    regex = new RegExp(`^${escaped.join(".*")}$`);
    globCache.set(glob, regex);
  }
  return regex;
}

const regexCache = new Map<string, RegExp | null>();

function compileRegex(source: string, flags = ""): RegExp | null {
  const key = `${flags}/${source}`;
  if (!regexCache.has(key)) {
    try {
      // Drop `g` and `y`: they make `test` stateful between calls.
      regexCache.set(key, new RegExp(source, flags.replace(/[gy]/g, "")));
    } catch {
      regexCache.set(key, null);
    }
  }
  return regexCache.get(key) ?? null;
}
