// Runs inside the page (MAIN world) at document_start, before the app's own scripts.
// Replaces window.fetch and XMLHttpRequest so the app's API calls can be answered with mocks.
// Requests with no matching mock go to the real fetch/XHR untouched — auth headers and cookies
// stay intact because nothing is redirected.
//
// Rule shape: { id, match: { url? | pattern? | domain?, method?, operationName? }, status, body, headers? }
(() => {
  const injectedAt = performance.now();
  let rules = null;
  window.__mockSpikeTiming = { injectedAt, rulesAt: null };

  // Rules arrive asynchronously from relay.js. Requests wait for the first delivery (max 1s) so
  // mocks also apply to calls fired during page load. Later deliveries replace the rules live.
  let markReady;
  const rulesReady = new Promise((resolve) => (markReady = resolve));
  setTimeout(markReady, 1000); // never hang the app if the extension can't answer
  addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__mockSpike !== "rules") return;
    rules = e.data.rules;
    window.__mockSpikeTiming.rulesAt ??= performance.now();
    markReady();
  });
  window.postMessage({ __mockSpike: "need-rules" }, "*");

  // --- Matching ------------------------------------------------------------------------
  const globToRegExp = (glob) =>
    new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");

  const urlMatches = (m, url) => {
    const u = new URL(url, location.href);
    if (m.url) return u.href === new URL(m.url, location.href).href;
    if (m.pattern) return globToRegExp(m.pattern).test(u.href);
    if (m.domain) return u.hostname === m.domain || u.hostname.endsWith("." + m.domain);
    return false;
  };

  const findRule = (method, url, bodyText) => {
    if (!rules?.length) return null;
    let operationName;
    return rules.find((r) => {
      const m = r.match ?? {};
      if (m.method && m.method.toUpperCase() !== method.toUpperCase()) return false;
      if (!urlMatches(m, url)) return false;
      if (m.operationName) {
        try {
          operationName ??= JSON.parse(bodyText).operationName;
        } catch {}
        if (m.operationName !== operationName) return false;
      }
      return true;
    });
  };

  const reportMatch = (rule, method, url, transport) =>
    window.postMessage({ __mockSpike: "match", id: rule.id, method, url, transport }, "*");

  const mockBody = (rule) => (typeof rule.body === "string" ? rule.body : JSON.stringify(rule.body ?? ""));
  const mockHeaders = (rule) => ({ "content-type": "application/json", ...lowerKeys(rule.headers) });
  const lowerKeys = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

  // --- fetch ---------------------------------------------------------------------------
  const realFetch = window.fetch;
  window.fetch = async function (input, init) {
    await rulesReady;
    const request = new Request(input, init);
    const bodyText = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    const rule = findRule(request.method, request.url, bodyText);
    if (!rule) return realFetch.call(this, input, init);

    reportMatch(rule, request.method, request.url, "fetch");
    return new Response(mockBody(rule), { status: rule.status ?? 200, headers: mockHeaders(rule) });
  };

  // --- XMLHttpRequest (what axios uses) ------------------------------------------------
  const XHR = XMLHttpRequest.prototype;
  const realOpen = XHR.open;
  const realSend = XHR.send;

  XHR.open = function (method, url, async = true, ...rest) {
    this.__mock = { method: String(method).toUpperCase(), url: new URL(url, location.href).href, async };
    return realOpen.call(this, method, url, async, ...rest);
  };

  XHR.send = function (body) {
    const info = this.__mock;
    // Synchronous XHR can't wait for rules: only mock it if rules are already here.
    if (!info || !info.async) {
      const rule = info && findRule(info.method, info.url, typeof body === "string" ? body : "");
      return rule ? fakeXhrResponse(this, rule, info) : realSend.call(this, body);
    }
    rulesReady.then(() => {
      const rule = findRule(info.method, info.url, typeof body === "string" ? body : "");
      if (rule) fakeXhrResponse(this, rule, info);
      else realSend.call(this, body);
    });
  };

  // Make this XHR look exactly like it received the mocked response from the network.
  function fakeXhrResponse(xhr, rule, info) {
    reportMatch(rule, info.method, info.url, "xhr");
    const text = mockBody(rule);
    const headers = mockHeaders(rule);
    let response = text;
    if (xhr.responseType === "json") {
      try {
        response = JSON.parse(text);
      } catch {
        response = null;
      }
    } else if (xhr.responseType === "blob") {
      response = new Blob([text], { type: headers["content-type"] });
    } else if (xhr.responseType === "arraybuffer") {
      response = new TextEncoder().encode(text).buffer;
    }
    const define = (prop, value) => Object.defineProperty(xhr, prop, { configurable: true, get: () => value });
    define("readyState", 4);
    define("status", rule.status ?? 200);
    define("statusText", rule.statusText ?? "");
    define("response", response);
    if (xhr.responseType === "" || xhr.responseType === "text") define("responseText", text);
    define("responseURL", info.url);
    xhr.getAllResponseHeaders = () =>
      Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
    xhr.getResponseHeader = (name) => headers[name.toLowerCase()] ?? null;

    // Fire events asynchronously, like a real network response would.
    setTimeout(() => {
      xhr.dispatchEvent(new Event("readystatechange"));
      const size = text.length;
      for (const type of ["load", "loadend"]) {
        xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded: size, total: size }));
      }
    }, 0);
  }
})();
