/** How a rule picks requests by URL. */
export type UrlMatcher =
  /** The same URL. Hash is ignored; a trailing slash is optional; see `matchesUrl` for query strings. */
  | { kind: "exact"; value: string }
  /** A glob where `*` matches any run of characters, `/` included. Example: `*://api.example.com/orders/*`. */
  | { kind: "wildcard"; value: string }
  /** A hostname. Also matches its subdomains: `example.com` matches `api.example.com`. */
  | { kind: "domain"; value: string }
  /** A JavaScript regular expression source, tested against the full URL. */
  | { kind: "regex"; value: string; flags?: string };

export type UrlMatcherKind = UrlMatcher["kind"];

/** Which requests a rule applies to. */
export interface RuleMatch {
  url: UrlMatcher;
  /** HTTP method, case-insensitive. Omitted or `*` matches every method. */
  method?: string;
}

/** What a matching request gets back instead of going to the network. */
export interface MockResponse {
  status: number;
  /** A string is sent as-is; anything else is sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockRule {
  id: string;
  match: RuleMatch;
  response: MockResponse;
  /** Epoch milliseconds after which the rule no longer applies. */
  expiresAt: number;
}

/** The parts of a request the matcher looks at. `url` must be absolute. */
export interface RequestInfo {
  method: string;
  url: string;
}
