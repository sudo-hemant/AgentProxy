import type { MockResponse } from "@agentproxy/shared";

/** A mock rule's response, in the form both the fetch and the XHR wrapper send back. */
export interface BuiltResponse {
  status: number;
  /** Header names are lower-cased. */
  headers: Record<string, string>;
  /** `null` for statuses that can't carry a body, such as 204 and 304. */
  body: string | null;
}

// The Response constructor throws if these statuses are given a body.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export function buildMockResponse(response: MockResponse): BuiltResponse {
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return {
    status: response.status,
    headers,
    body: NULL_BODY_STATUSES.has(response.status) ? null : bodyText(response.body),
  };
}

/** A string is sent as-is; anything else is sent as JSON. No body is an empty string. */
function bodyText(body: unknown): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}
