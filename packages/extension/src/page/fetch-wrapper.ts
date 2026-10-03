import type { MatchReport } from "@agentproxy/shared";
import { buildMockResponse } from "./mock-response.js";
import type { RuleStore } from "./rule-store.js";

export type ReportMatch = (match: MatchReport) => void;

/**
 * A replacement for `fetch` that answers matching requests with their mock. Every other request
 * goes to `realFetch` with the caller's original arguments, so its headers, cookies and body are
 * untouched. `baseUrl` resolves relative request URLs, as the page's own fetch would.
 */
export function createMockFetch(
  realFetch: typeof fetch,
  store: RuleStore,
  reportMatch: ReportMatch,
  baseUrl: string,
): typeof fetch {
  return async (input, init) => {
    await store.ready;
    const request = describeRequest(input, init, baseUrl);
    const rule = request && store.find(request);
    if (!request || !rule) return realFetch(input, init);

    init?.signal?.throwIfAborted();
    reportMatch({ ruleId: rule.id, method: request.method, url: request.url, transport: "fetch" });
    const { status, headers, body } = buildMockResponse(rule.response);
    const response = new Response(body, { status, headers });
    // A constructed Response has an empty url; a network one has the request's.
    Object.defineProperty(response, "url", { value: request.url });
    return response;
  };
}

/** The method and absolute URL of a fetch call, or undefined if the URL is invalid. */
function describeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  baseUrl: string,
): { method: string; url: string } | undefined {
  const isRequest = input instanceof Request;
  const method = (init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
  try {
    const url = new URL(isRequest ? input.url : String(input), baseUrl).href;
    return { method, url };
  } catch {
    return undefined;
  }
}
