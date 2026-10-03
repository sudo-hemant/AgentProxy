import { type MockRule, type UrlMatcher, validateUrlMatcher } from "@agentproxy/shared";
import { z } from "zod";

export const DEFAULT_EXPIRES_IN_SECONDS = 600;
export const MAX_EXPIRES_IN_SECONDS = 86_400;

/**
 * What the agent passes to `set_mock`. Flat and forgiving: only `url` is required. The field
 * descriptions are what the agent reads, so they explain the behaviour, not just the type.
 */
export const mockInputShape = {
  url: z
    .string()
    .min(1)
    .describe(
      "Which requests to mock, read according to match_type. For wildcard, * matches anything, " +
        "e.g. '*/api/orders' or 'https://api.example.com/orders/*'. The query string is ignored " +
        "unless the pattern has one.",
    ),
  match_type: z
    .enum(["wildcard", "exact", "domain", "regex"])
    .default("wildcard")
    .describe(
      "wildcard (default): a URL pattern with *. exact: one full URL. domain: a host and all " +
        "its subdomains. regex: a JavaScript regular expression tested against the full URL.",
    ),
  regex_flags: z.string().optional().describe("Flags for a regex match_type, e.g. 'i'."),
  method: z
    .string()
    .regex(/^([A-Za-z]+|\*)$/, "must be an HTTP method like GET, or *")
    .optional()
    .describe("HTTP method to match, e.g. GET or POST. Matches every method if left out."),
  status: z
    .number()
    .int()
    .min(200)
    .max(599)
    .default(200)
    .describe("HTTP status of the mocked response, 200–599."),
  body: z
    .unknown()
    .optional()
    .describe("Response body. A string is sent as-is; anything else is sent as JSON."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Response headers. content-type defaults to application/json."),
  expires_in_seconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_EXPIRES_IN_SECONDS)
    .default(DEFAULT_EXPIRES_IN_SECONDS)
    .describe("How long the mock lasts. Default 600 (10 minutes), at most 86400 (24 hours)."),
  id: z
    .string()
    .regex(/^[\w.-]{1,64}$/, "use up to 64 letters, digits, _, . or -")
    .optional()
    .describe("Name for the mock. Setting a mock with an existing id replaces that mock."),
};

export const mockInputSchema = z.object(mockInputShape);
/** The input after zod has applied the defaults. */
export type MockInput = z.output<typeof mockInputSchema>;

export type ToRuleResult = { ok: true; rule: MockRule } | { ok: false; errors: string[] };

/** Turns a checked input into a rule, or explains why the URL pattern can't work. */
export function toMockRule(input: MockInput, now: number, newId: () => string): ToRuleResult {
  const url: UrlMatcher =
    input.match_type === "regex"
      ? { kind: "regex", value: input.url, flags: input.regex_flags }
      : { kind: input.match_type, value: input.url };
  const errors = validateUrlMatcher(url);
  if (input.regex_flags !== undefined && input.match_type !== "regex") {
    errors.push("regex_flags only applies when match_type is regex");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    rule: {
      id: input.id ?? newId(),
      match: { url, method: input.method?.toUpperCase() },
      response: { status: input.status, body: input.body, headers: input.headers },
      expiresAt: now + input.expires_in_seconds * 1000,
    },
  };
}
