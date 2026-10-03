import type { MockRule } from "@agentproxy/shared";
import type { ReportMatch } from "./fetch-wrapper.js";
import { buildMockResponse } from "./mock-response.js";
import type { RuleStore } from "./rule-store.js";

/** What `open` recorded about a request, kept until `send`. */
interface OpenedRequest {
  method: string;
  url: string;
}

/**
 * Patches `XMLHttpRequest` so requests that match a rule get the mocked response, and every
 * other request is sent unchanged by the real `send`. Returns a function that undoes the patch.
 */
export function installXhrWrapper(
  Xhr: typeof XMLHttpRequest,
  store: RuleStore,
  reportMatch: ReportMatch,
  baseUrl: string,
): () => void {
  const proto = Xhr.prototype;
  const realOpen = proto.open;
  const realSend = proto.send;
  const opened = new WeakMap<XMLHttpRequest, OpenedRequest>();

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      opened.set(this, { method: method.toUpperCase(), url: new URL(String(url), baseUrl).href });
    } catch {
      opened.delete(this); // an invalid URL: the real open throws, as it should
    }
    return (realOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const request = opened.get(this);
    if (!request) return realSend.call(this, body);
    store.ready.then(() => {
      const rule = store.find(request);
      if (!rule) return realSend.call(this, body);
      reportMatch({ ruleId: rule.id, method: request.method, url: request.url, transport: "xhr" });
      respondWithMock(this, rule, request.url);
    });
  };

  return () => {
    proto.open = realOpen;
    proto.send = realSend;
  };
}

/** Makes the XHR look exactly as if the mocked response had come from the network. */
function respondWithMock(xhr: XMLHttpRequest, rule: MockRule, url: string): void {
  const { status, headers, body } = buildMockResponse(rule.response);
  const text = body ?? "";
  const define = (name: string, value: unknown) =>
    Object.defineProperty(xhr, name, { configurable: true, get: () => value });

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

  // A real response arrives asynchronously, after send has returned.
  setTimeout(() => {
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
  }, 0);
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
