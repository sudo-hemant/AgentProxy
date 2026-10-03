import type { MockRule } from "@agentproxy/shared";
import type { ReportMatch } from "./fetch-wrapper.js";
import { buildMockResponse } from "./mock-response.js";
import type { RuleStore } from "./rule-store.js";

/** What `open` recorded about a request, kept until `send`. */
interface OpenedRequest {
  method: string;
  url: string;
  async: boolean;
}

/**
 * Patches `XMLHttpRequest` so requests that match a rule get the mocked response, and every
 * other request is sent unchanged by the real `send`. Returns a function that undoes the patch.
 */
export function installXhrWrapper(
  Xhr: typeof XMLHttpRequest,
  store: RuleStore,
  reportMatch: ReportMatch,
  getBaseUrl: () => string,
): () => void {
  const proto = Xhr.prototype;
  const realOpen = proto.open;
  const realSend = proto.send;
  const realAbort = proto.abort;
  const opened = new WeakMap<XMLHttpRequest, OpenedRequest>();
  // Async requests whose send is waiting for the rules. A new token per send, so an answer
  // meant for an earlier, cancelled send is recognised and dropped.
  const waiting = new WeakMap<XMLHttpRequest, object>();

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    // Opening again cancels a send still waiting for the rules, and starts with a clean object.
    waiting.delete(this);
    clearMockedResponse(this);
    try {
      opened.set(this, {
        method: method.toUpperCase(),
        url: new URL(String(url), getBaseUrl()).href,
        // `open(method, url)` is async; with a third argument, that argument decides.
        async: rest.length === 0 || Boolean(rest[0]),
      });
    } catch {
      opened.delete(this); // an invalid URL: the real open throws, as it should
    }
    return (realOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const request = opened.get(this);
    if (!request) return realSend.call(this, body);
    const answer = () => {
      const rule = store.find(request);
      if (!rule) return realSend.call(this, body);
      reportMatch({ ruleId: rule.id, method: request.method, url: request.url, transport: "xhr" });
      respondWithMock(this, rule, request.url, request.async);
    };
    // A synchronous request must finish before send returns, so it can't wait for the rules:
    // it is mocked only if they have already arrived.
    if (!request.async) return store.hasRules() ? answer() : realSend.call(this, body);
    const token = {};
    waiting.set(this, token);
    store.ready.then(() => {
      if (waiting.get(this) !== token) return; // aborted or re-opened meanwhile
      waiting.delete(this);
      answer();
    });
  };

  proto.abort = function (this: XMLHttpRequest) {
    // The real XHR hasn't been sent yet, so its abort would do nothing: abort it ourselves.
    if (!waiting.delete(this)) return realAbort.call(this);
    abortWaiting(this);
  };

  return () => {
    proto.open = realOpen;
    proto.send = realSend;
    proto.abort = realAbort;
  };
}

/** Makes the XHR look exactly as if the mocked response had come from the network. */
function respondWithMock(xhr: XMLHttpRequest, rule: MockRule, url: string, async: boolean): void {
  const { status, headers, body } = buildMockResponse(rule.response);
  const text = body ?? "";
  const define = (name: string, value: unknown) => overrideProperty(xhr, name, value);

  define("readyState", XMLHttpRequest.DONE);
  define("status", status);
  define("statusText", "");
  define("responseURL", url);
  define("response", responseFor(xhr.responseType, text, headers["content-type"] ?? ""));
  if (xhr.responseType === "" || xhr.responseType === "text") define("responseText", text);
  xhr.getResponseHeader = (name) => headers[name.toLowerCase()] ?? null;
  xhr.getAllResponseHeaders = () =>
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");

  const fireEvents = () => {
    xhr.dispatchEvent(new Event("readystatechange"));
    for (const type of ["load", "loadend"]) {
      xhr.dispatchEvent(
        new ProgressEvent(type, {
          lengthComputable: true,
          loaded: text.length,
          total: text.length,
        }),
      );
    }
  };
  // An async response arrives after send has returned; a sync one, before it returns.
  if (async) setTimeout(fireEvents, 0);
  else fireEvents();
}

/** Fires what a browser fires when a sent request is aborted, then leaves the XHR unsent. */
function abortWaiting(xhr: XMLHttpRequest): void {
  overrideProperty(xhr, "readyState", XMLHttpRequest.DONE);
  overrideProperty(xhr, "status", 0);
  xhr.dispatchEvent(new Event("readystatechange"));
  for (const type of ["abort", "loadend"]) {
    xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: false, loaded: 0, total: 0 }));
  }
  overrideProperty(xhr, "readyState", XMLHttpRequest.UNSENT);
}

/** Every property a mocked response or an abort sets on the XHR object itself. */
const OVERRIDDEN = [
  "readyState",
  "status",
  "statusText",
  "responseURL",
  "response",
  "responseText",
  "getResponseHeader",
  "getAllResponseHeaders",
] as const;

function overrideProperty(xhr: XMLHttpRequest, name: string, value: unknown): void {
  Object.defineProperty(xhr, name, { configurable: true, get: () => value });
}

/** Removes the overrides so the XHR's own properties and methods show through again. */
function clearMockedResponse(xhr: XMLHttpRequest): void {
  for (const name of OVERRIDDEN) delete (xhr as unknown as Record<string, unknown>)[name];
}

/** The value of `xhr.response` for the request's `responseType`. */
function responseFor(
  responseType: XMLHttpRequestResponseType,
  text: string,
  contentType: string,
): unknown {
  switch (responseType) {
    case "json":
      try {
        return JSON.parse(text);
      } catch {
        return null; // what a browser gives for a body that isn't valid JSON
      }
    case "blob":
      return new Blob([text], { type: contentType });
    case "arraybuffer":
      return new TextEncoder().encode(text).buffer;
    default:
      return text;
  }
}
