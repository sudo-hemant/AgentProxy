# Agent-controlled network overrides: feasibility research

*Date: 2026-10-02. Status: research only. No architecture decision has been made.*

**How to read the evidence tags:**
- ✅ means checked against primary docs, Chromium source, or the tool's own source code.
- ⚠️ means partly verified, or the source is secondary.
- ❓ means not verified; treat it as something a test needs to confirm.

---

## TL;DR

- **This is feasible.** Every building block exists today, and nothing on the platform rules the idea out. The hard part is choosing where the overrides are applied. No single mechanism catches every kind of request and also needs no setup.
- **Agents can already control overrides, but only in narrow ways:**
  - System-wide intercepting proxies (Proxyman, HTTP Toolkit, Fiddler) have official MCP servers that can create rules. All three are paid or "Pro" for write access, and all need a certificate (CA) installed plus proxy setup.
  - Standalone mock servers (MockServer, WireMock Cloud, Beeceptor, and others) have MCP servers too. The app has to be pointed at the mock server instead of the real API.
  - Playwright MCP's `browser_route` can mock responses, but only basic ones, and only in the browser the agent itself launched.
  - Requestly has an official MCP server, but it goes through Requestly's cloud API with a key you have to apply for. The rules only reach the extension while an app.requestly.io tab is open. The agent gets no feedback on whether a rule actually fired.
- **What's missing:** a local override layer, built for agents and needing no configuration, that:
  1. applies in whichever browser the agent is actually looking at;
  2. supports everything an override might need: mock the body, status and headers; patch the real response; delay; fail the request; redirect;
  3. tells the agent which rule matched which request, so it can check its own work;
  4. keeps the rules as files in the repo.
- **The main technical trade-off (Chrome):**
  - The extension rule API (`declarativeNetRequest`, DNR) can block, redirect and change headers, but **cannot change response bodies or status codes**.
  - Replacing `fetch`/XHR inside the page can change bodies, but **only for fetch/XHR calls the page itself makes**.
  - Full control over every request type needs `chrome.debugger` (the DevTools Protocol `Fetch` API). That puts a "started debugging this browser" bar on every tab.
- **An easily missed blind spot:** requests made by the app's server never pass through the browser. This covers server-side rendering, API routes and backend-for-frontend calls. Only a proxy or a hook in the server's runtime can intercept those.
- **The most promising way to connect agents:** a local MCP server that holds the rules and the match logs, and pushes rules into one or more *enforcement adapters* (extension, DevTools Protocol, proxy). The main open decision is which adapter to build first (§5).

---

## 1. Existing tools

### 1.1 Five ways existing tools intercept traffic

| Mechanism family | How it works | Examples |
|---|---|---|
| **Extension rule API (DNR)** | The extension registers rules that the browser applies in its network stack | ModHeader, and Requestly's header, redirect and block rules |
| **In-page `fetch`/XHR patching** | A script runs in the page's own JavaScript context before the page's code and replaces `window.fetch` and `XMLHttpRequest` | Requestly Modify Response, Tweak, Mokku |
| **Intercepting proxy** | The browser or OS sends traffic through a local proxy that decrypts HTTPS using an installed CA certificate | Charles, Proxyman, HTTP Toolkit (mockttp), mitmproxy, Fiddler, Requestly Desktop |
| **DevTools Protocol `Fetch` API** | A debugging client (an extension using `chrome.debugger`, Puppeteer/Playwright, or an MCP server) pauses requests and answers them itself | Playwright `route`, Puppeteer interception, DevTools Local Overrides |
| **Code inside the app** | A service worker or library inside the app answers requests | MSW, `@requestly/web-sdk` |

There's also a sixth option: **standalone mock servers** (Mockoon, WireMock, Prism, json-server, MockServer). These don't intercept anything; the app is pointed at them through configuration or environment variables.

### 1.2 How much an agent can control each tool

| Tool | Mechanism | Can change response body? | Agent / programmatic control | Setup cost | Main limitation |
|---|---|---|---|---|---|
| Requestly (extension) | DNR + in-page patching | Yes, but only page fetch/XHR | Official MCP over the cloud API (§2.6) | Extension, account, API key | Cloud round trip; no feedback |
| ModHeader | DNR | No | Import/export only | Extension | Headers and redirects only |
| Tweak / Mokku | In-page patching | Yes (fetch/XHR) | Import/export only | Extension | No API |
| Resource Override | Older `webRequest` (Manifest V2) | Only by redirecting to a file | None | — | Discontinued ✅ |
| Charles | Proxy | Yes | Web interface can only toggle features; community MCP is read-only ✅ | CA and system proxy | Agent can't create rules |
| **Proxyman** | Proxy | Yes | **Official MCP** that can create Map Local, Map Remote, breakpoint, script and block rules ✅ | CA and proxy; macOS only | Can't update or delete rules; macOS only |
| **HTTP Toolkit** | Proxy (mockttp) | Yes | **Official MCP** that reads traffic and edits rules; writes need Pro ✅ | Low: it launches its own pre-configured Chrome | Paid for writes; a fresh browser profile, not the developer's own |
| **Fiddler Everywhere** | Proxy | Yes | **Official MCP** that captures traffic and creates rules; Pro ✅ | CA and proxy | Paid; needs internet |
| mitmproxy | Proxy + Python add-ons | Yes | Community MCPs (e.g. `snapspecter/mitmproxy-mcp`, about 120 stars) ✅ | CA and proxy | Build-it-yourself |
| MockServer / WireMock / Beeceptor | Mock server | Yes | Built-in or official MCPs (WireMock's is Cloud-only) ✅ | Point the app's base URL at the mock | Replaces whole services; doesn't override individual calls in real traffic |
| MSW | Service worker inside the app | Yes | Community `msw-mcp` (about 80 stars) ✅ | `npx msw init` plus code changes | Invasive; JavaScript apps only |
| **@playwright/mcp** | DevTools Protocol (Playwright `route`) | Yes (fulfil only) | **Official** `browser_route`, `browser_unroute` and `browser_route_list` with `--caps=network` ✅ | Usually its own browser | No delay, no abort, no "modify the real response"; tied to the automation session |
| chrome-devtools-mcp | DevTools Protocol | **No** | Official MCP, but inspect, emulate and throttle only. The interception feature request (#848) is open ✅ | `npx` | No interception |
| DevTools Local Overrides | DevTools front end | Yes | **None** ✅ | DevTools must be open | Manual only |

### 1.3 What existing tools already solve, and what's missing

**Already solved:**
- Agent control of a *system-wide* proxy (Proxyman, HTTP Toolkit, Fiddler).
- Agent control of a *separate mock server*.
- Basic mocking inside an *agent-launched* automation browser (Playwright MCP).
- In-app mocking for apps that already use MSW.

**Not solved yet:**
1. Overrides in the **developer's own browser** (logged in, real cookies), driven by an agent, with no proxy, certificate, code change, or DevTools window open.
2. **Every override type in one schema an agent can use easily.** Playwright's `browser_route` can't delay, abort, or patch the real response.
3. **Managing and observing rules from an agent:** listing, updating, toggling and deleting rules, scoping them to a tab or origin, and logs showing "rule X matched request Y". Proxyman's MCP can't even update or delete rules.
4. **Rules as files in the repo**, versioned and shareable, while the agent can still change them live.
5. **One set of rules that follows the agent** across whichever browser or process it's testing.

---

## 2. Requestly in depth

*Based on Requestly's source code, cloned and read. In 2026 the extension and web-app code moved to `requestly/interceptor`; `requestly/requestly` now promotes the closed-source API Client. BrowserStack acquired Requestly in May 2025.* ✅

### 2.1 Architecture

```
app.requestly.io (React web app, also embedded in the Electron desktop app)
   │  window.postMessage
   ▼
content script app.cs.js (injected ONLY on *.requestly.io / requestly.com)
   │  chrome.runtime.sendMessage
   ▼
extension service worker ── chrome.storage.local (all rules live here)
   │                         ▲
   │                         └── Firebase "sync" nodes (cloud sync runs IN THE WEB APP, not the extension)
   ├─ declarativeNetRequest dynamic rules
   ├─ in-page script (fetch/XHR patching)
   └─ WebSocket client → desktop app on 127.0.0.1:59763 (proxy handshake only)
```

- **The web app is the control plane.** It writes raw storage records into the extension through a content-script bridge (`GET/SAVE/REMOVE_STORAGE_OBJECT`). It does not use `externally_connectable`, which is limited to BrowserStack domains. ✅
- **The rules are compiled to DNR inside the web app, not in the extension.** The compiled result is stored on each rule as `extensionRules`. The extension service worker just wipes all DNR dynamic rules and re-adds them on every change, debounced by 500 ms. ✅
- **Cloud sync works through the web app.** Rules reach the extension from the cloud only while an app.requestly.io tab is open. ✅
- **The desktop app ↔ extension connection is a WebSocket** with four messages (`get-proxy`, `browser-connected`, `browser-disconnected`, `heartbeat`). Once connected, the extension points `chrome.proxy` at the desktop proxy and **turns off its own rule engine**. No rule create/update/delete goes over this socket. ✅

### 2.2 How each rule type is enforced

| Rule type | Extension mechanism |
|---|---|
| Redirect / Map Remote, Replace, Query Param, Cancel, Headers, User-Agent | DNR (`redirect`, regex substitution, `queryTransform`, `block`, `modifyHeaders`) ✅ |
| Delay, fetch/XHR | `setTimeout` inside the in-page script ✅ |
| Delay, other resources | DNR redirect to **`https://app.requestly.io/delay/N/...`**, so Requestly's own server does the delaying ✅ |
| Modify Request Body / Modify Response | In-page script registered with `scripting.registerContentScripts({world:"MAIN", runAt:"document_start", allFrames})`. Rules are pushed into `window.__REQUESTLY__` on each navigation and each rule change. "Code" rules run through `new Function` ✅ |
| Insert Script | `scripting.executeScript` into the page context, plus a DNR rule that removes the CSP header ✅ |
| Map Local, and HTML/JS/CSS response changes | **Desktop app only**: "available only in desktop app due to technical constraints" ✅ |

- **`webRequest` is used for read-only logging.** The extension doesn't use `chrome.debugger` at all. ✅
- **Documented or code-visible limitations:**
  - Response mocking only covers fetch/XHR made by the page.
  - Workers and service workers aren't patched (inferred from the code).
  - Requests the page makes very early can slip through, because rules are injected asynchronously after the navigation commits (inferred from the code).
  - A page's CSP blocks "code" rules, and the workaround strips the CSP.
  - Changes don't show up in DevTools.
  - Delays are capped at 5 s for fetch/XHR and 10 s for other requests.
  - Path matching isn't compiled to DNR.
  - Most conditions compile to `regexFilter`, so they count toward Chrome's limit of about 1,000 regex rules.

### 2.3 Permissions (`manifest.chrome.json`) ✅

- **`permissions`:** `browsingData`, `contextMenus`, `declarativeNetRequest`, `proxy`, `scripting`, `sidePanel`, `storage`, `tabs`, `unlimitedStorage`, `webNavigation`, `webRequest`.
- **`host_permissions`:** `<all_urls>`.
- **Content script `client.cs.js`:** runs on every http/https page, in all frames, at `document_start`.

There are also Firefox, Edge and Safari manifest variants.

### 2.4 Rule data model ✅

- **A rule has:** `{id, name, objectType:"rule", status: Active|Inactive, ruleType, groupId, pairs[], extensionRules}`.
- **Each `pairs[]` entry has:**
  - a `source`: `{key: Url|host|path, operator: Equals|Contains|Matches|Wildcard_Matches, value, filters: [{pageUrl, pageDomains, requestMethod, resourceType, requestPayload}]}`;
  - type-specific fields. For example, a Response rule has `{type: code|static, value, statusCode, resourceType: restApi|graphqlApi|static, serveWithoutRequest}`.
- **Groups** turn their rules on or off together.
- **Import and export:** rules can be exported and imported as JSON. Importers exist for Charles, ModHeader, Header Editor and Resource Override.

The model is a reasonable reference design. It is more nested than an agent needs, though: pairs, filters, and the compiled `extensionRules` stored alongside the source.

### 2.5 The desktop app (proxy mode) ✅

- **Proxy:** a fork of `http-mitm-proxy` (`@requestly/requestly-proxy`), with one processor per rule action. Rules come from an in-memory cache filled from the desktop app's storage.
- **Certificate install:** `security add-trusted-cert` on macOS and `certutil` on Windows.
- **Browsers:** Chromium is launched with a fresh profile, `--ignore-certificate-errors-spki-list`, and `<-loopback>`, which makes Chrome send localhost traffic through the proxy too.
- **Terminal and Node.js:** a new terminal gets `HTTP(S)_PROXY`, `NODE_EXTRA_CA_CERTS`, `GLOBAL_AGENT_*`, and a `NODE_OPTIONS` preload script. **This is the precedent for catching requests the dev server makes server-side.**
- **Also supported:** Android (adb), the iOS Simulator, and Electron apps.

### 2.6 Existing ways to control Requestly programmatically

| Surface | What it does | Gaps for agents |
|---|---|---|
| Public REST API (beta), `api2.requestly.io/v1` | Create, read, update and delete rules and groups ✅ | Key granted manually through a form; cloud only |
| `@requestly/mcp` (v1.0.4, July 2026) | 8 tools, which are create, read, update and delete for rules and groups. New rules default to Inactive, and Response and Script rules are **forced Inactive** until a human turns them on ✅ | No local path, no traffic or match logs, no feedback. Possible schema mismatch (`Host` vs `host`) ❓ |
| `@requestly/rq-automation` | Drives the extension in Selenium, Playwright or Puppeteer through "magic URLs" on app.requestly.io ✅ | Built for test automation, not live dev |
| `@requestly/web-sdk` | In-page `Network.intercept` ✅ | Requires a code change; last commit 2024 |

### 2.7 What could be exposed to an agent, and what's blocking it today

**Exposable:**
- The whole rule model.
- Turning groups on and off, and pausing the extension.
- Execution logs.
- Network recording / HAR export.
- In desktop mode, launching proxied browsers and terminals.

**Blocking it today:**
1. **There's no local way in.** The extension only accepts writes from Requestly's own domains. There's no native messaging or localhost API, and the desktop WebSocket doesn't carry rules.
2. **Rules take a long path to reach the browser:** agent → cloud API → Firebase → an open app.requestly.io tab → the extension. The DNR compilation also happens in the web app. ❓ Whether rules created through the API do anything before the web app recompiles them.
3. **No feedback.** Matches and traffic stay inside the extension.
4. **Rules aren't files.** Only the API Client has file-based or git workspaces.

**Licensing:** whether we could fork or reuse `requestly/interceptor` code or its rule schema depends on its license. ❓ Check it before considering reuse.

---

## 3. Our problem

### 3.1 The workflow and the pain point

**Today:**
1. The agent changes code and wants to test it under a particular scenario: the API returns 500, an empty list, a slow response, an expired token, a feature-flag header, or a new field the backend hasn't shipped yet.
2. **A human stops what they're doing, opens Requestly, writes the rule, and tells the agent it's ready.**
3. The agent checks the result through a browser tool (Claude in Chrome, Playwright MCP, chrome-devtools-mcp), often without knowing whether the rule actually fired.
4. The human remembers to clean the rule up afterwards.

**Target:**
1. The agent calls something like `mock_response({match: "GET */api/orders", status: 500})`.
2. The agent reloads and checks the page.
3. The agent asks "which rules matched?" to confirm the override took effect.
4. The agent removes the rule, or saves it as a reusable scenario file in the repo.

**The value comes from three things:** removing the human round trip, closing the verification loop, and making scenarios reproducible.

### 3.2 The hardest challenges

**1. Coverage: which requests can be overridden at all?**
- **Client-side fetch/XHR** is easy: every mechanism covers it.
- **Navigations, scripts, CSS and images** need DNR redirects, the DevTools Protocol `Fetch` API, or a proxy. Patching inside the page can't reach them.
- **Requests from workers and service workers** need the DevTools Protocol with auto-attach to worker targets, or a proxy. DNR does see network-level fetches made by a service worker. ✅
- **Server-side requests** (Next.js server components and route handlers, Remix loaders, Nuxt server routes, Rails/Django backends calling other APIs) **never reach the browser.** The only ways to catch them are a proxy plus environment variables, or a runtime preload hook. ⚠️ Node's built-in `fetch` historically ignored `HTTP_PROXY`; newer Node versions add an opt-in setting for it ❓, which is why Requestly uses a preload script.
- **This is the single biggest problem with "framework-agnostic" + "browser extension".** The product needs to be honest about it: "browser-side requests only" is a real scope boundary.

**2. Which browser is the agent looking at?**
- The override has to apply in the browser the agent is observing, which may be:
  - the developer's real Chrome (Claude in Chrome, or chrome-devtools-mcp with auto-connect);
  - a browser the agent launched (Playwright MCP or chrome-devtools-mcp, which use a separate profile);
  - a headless one.
- An extension-only design works for the first case.
- Chrome 137+ (branded builds) **removed `--load-extension`** ✅, so agent-launched Chrome can't easily load our extension. Chromium and Chrome for Testing still can.
- This argues for a rule engine that doesn't depend on any one browser.

**3. The communication chain**
- The full chain is: agent → MCP server (a local process started by the agent host) → ??? → browser → app.
- An MCP server's lifetime is usually tied to the agent session, while the browser and extension live independently. That makes discovery, reconnection, and **several agent sessions talking to one browser** real design problems.

**4. Timing and consistency**
- DNR updates are atomic, and most likely apply only to requests that start after the update finishes. ❓
- In-page patchers receive rules asynchronously, so very early requests are at risk (Requestly has the same problem).
- The HTTP cache and the service worker cache can hide changes. DNR doesn't affect responses a service worker builds itself. ✅
- The agent needs a clear signal that the rule is active and it should reload now.

**5. A rule format an LLM can use**
- The schema should be flat and easy to get right.
- Matching needs URL glob/regex, method, and ideally the GraphQL operation name and the request body.
- Actions: mock, **patch the real response** (merge JSON into what the server actually returned), headers, delay, fail, redirect.
- Rules need lifetimes (one shot, N times, for this session) so the agent doesn't leave them behind.

**6. Observability**
- Logs of matched requests, and ideally a way to capture real request/response pairs, so the agent can build a mock from real data instead of guessing its shape.

### 3.3 Security and permission boundaries

| Boundary | What it means for us |
|---|---|
| **Extension permissions** | `<all_urls>` host access is unavoidable for "any API host". `debugger` adds the install warnings "Access the page debugger backend" and "Read and change all your data", and probably extra Chrome Web Store review. ✅ / ❓ |
| **`chrome.debugger` infobar** | "<ext> started debugging this browser" appears on every tab. Only the `--silent-debugger-extension-api` flag or a policy (enterprise) install suppresses it. ✅ |
| **Local WebSocket/HTTP channel** | Browsers don't apply CORS to WebSockets, so **any website can try to connect to `ws://localhost:PORT`**. Mitigations: bind to 127.0.0.1, check that `Origin` is `chrome-extension://<id>`, require a pairing token, and check `Host` to block DNS rebinding. Native messaging is the strongest option, because Chrome verifies the extension ID, but it needs a per-browser host manifest. ✅ |
| **Local Network Access (Chrome 142+)** | Public sites asking to reach localhost get a permission prompt. An extension with the right host permissions is "not impacted" (Chromium extensions team). WebSocket coverage is targeted at M147. ✅ / ⚠️ Retest when it ships. |
| **HTTPS (proxy approaches)** | Needs a trusted CA: the OS trust store for Chrome, NSS or enterprise roots for Firefox. Alternatively, launch a separate profile with `--ignore-certificate-errors-spki-list` (only works together with `--user-data-dir`). Also needed: turn off QUIC and add `<-loopback>`. ✅ |
| **CORS for fake responses** | Responses built in the page skip CORS checks. DevTools Protocol `fulfillRequest` and proxy responses **must include `Access-Control-Allow-Origin`** (the exact origin when credentials are sent) **and must answer `OPTIONS` preflight requests**. DNR redirects to `data:` URLs or extension files hit null-origin, credentials, and POST-redirect problems. ⚠️ |
| **CSP** | Scripts injected from extension files are allowed. Rules built from strings (`eval`, `new Function`) break under a strict CSP. Requestly strips the CSP, which we should avoid doing silently. ✅ |
| **Automation restrictions** | `--load-extension` was removed in branded Chrome 137. Since Chrome 136, `--remote-debugging-port` requires a non-default `--user-data-dir`. Chrome 144+ adds **auto-connect**: a user-approved DevTools Protocol connection to the real profile. ✅ |
| **Prompt injection / blast radius** | An agent that can rewrite traffic in a *logged-in, real* browser is a powerful target. A malicious page or document could steer the agent into redirecting a banking domain or injecting a script. Possible mitigations: restrict rules to development origins by default (e.g. the page's top-level domain is `localhost`, using DNR `topDomains`/`initiatorDomains`); give rules lifetimes; show a visible "overrides active" indicator; leave script injection out or behind human approval. Requestly's MCP sets a precedent: response and script rules start Inactive. |

---

## 4. Possible approaches

| # | Approach | Can change response body? | Request types covered | Real browser profile? | Setup | Agent → enforcement path | Main risk |
|---|---|---|---|---|---|---|---|
| A | **Extension: DNR + in-page patching** | fetch/XHR only | Headers/redirect/block: all browser requests. Bodies: page fetch/XHR | ✅ | Install the extension, pair once | MCP ↔ local WebSocket ↔ extension | Blind spots for documents, workers, early requests; server-side not covered |
| B | **Extension + `chrome.debugger` (DevTools Protocol `Fetch`)** | All HTTP | All browser requests (workers and child frames need auto-attach) | ✅ | Install, pair, accept the scary warning, live with the infobar | Same as A | Infobar every time, store review, conflicts with DevTools' own interception ❓ |
| C | **MCP talks the DevTools Protocol directly (no extension)** | All HTTP | All browser requests | ✅ with Chrome 144 auto-connect, or the agent's own browser via a debugging port | A toggle in `chrome://inspect` plus a per-connection dialog ❓; or a separate profile | MCP → DevTools Protocol WebSocket | Interception lasts only as long as the MCP process; coordinating with other DevTools clients (chrome-devtools-mcp, Playwright) |
| D | **Local intercepting proxy run by the MCP server** | All HTTP | Browser **and server-side**, mobile, CLI | Only if the proxy is applied system-wide; otherwise a separate profile | CA certificate, `<-loopback>`, QUIC off, environment variables for the dev server | MCP *is* the proxy, so the simplest control path | Setup friction, CA trust, the Node `fetch` proxy gap ❓ |
| E | **Service worker inside the app (MSW-style)** | Yes | In-scope page requests | ✅ | Code or app change; conflicts with the app's own service worker | Page ↔ MCP | Breaks the "no app changes" constraint ✅ |
| F | **Dev-server plugin (Vite, Next or Webpack middleware)** | Yes, for server-routed calls | Whatever goes through the dev server | n/a | Config change for each framework | MCP ↔ plugin | Not framework-agnostic |
| — | **Firefox variant of A** | **Yes, for all HTTP**, via `webRequest.filterResponseData` | All browser requests | ✅ | Install the extension | Same as A | Firefox only; Safari has no equivalent ✅ |

**Notes:**
- **A is the minimum setup in the developer's real browser,** but it inherits Requestly's blind spots. It's enough for the most common agent scenario: the page's own API calls returning edge cases.
- **B and C give full fidelity in the browser.** C needs no extension at all, and is basically "chrome-devtools-mcp with interception added", which Google hasn't built (#848 is still open). The catch: interception exists only while some process holds the DevTools Protocol connection.
- **D is the only option that covers server-side requests,** and the most complete overall. It also has the most setup friction, which is what the requirements most want to avoid.
- **E and F break the "framework-agnostic / no app changes" constraints.** At most they're optional extras.
- **Combining approaches is natural:** the same rule can be enforced by the extension for the page and by the proxy for the server.

---

## 5. Candidate high-level architectures

### Shared idea: a local MCP server is the control plane

In every option, the agent talks to a **local MCP server** over stdio. The MCP server:
- holds the **rules** (in memory for the session, optionally saved to `<repo>/.<tool>/scenarios/*.json`);
- holds a **match log**;
- exposes tools such as `list_rules`, `add_rule`, `update_rule`, `remove_rule`, `enable/disable`, `get_matches`, `capture_traffic`, `load_scenario`.

The options differ in **how rules reach the place where they're enforced.**

### Architecture 1: Extension-first

```
AI agent ──stdio──▶ MCP server ◀──ws://127.0.0.1 (paired token)──▶ Extension service worker
  (rules + log, rules in memory or repo files)                          │
                                                                        ├─ DNR session/dynamic rules (headers, redirect, block, delay)
                                                                        ├─ In-page fetch/XHR patcher (mock and patch bodies)
                                                                        └─ webRequest (read-only) → matches reported back to MCP
                                                    Developer's real browser ──▶ local app / remote APIs
```

- **Where rules live:** the MCP server is the source of truth. The extension caches them in `chrome.storage.session` and reapplies them when it reconnects.
- **How changes reach the browser:** the MCP server pushes the rules; the extension compiles them into DNR and in-page rules and acknowledges, so the agent knows it can reload.
- **For:** works in the developer's real profile, with no certificate and no app changes.
- **Against:** response bodies only for fetch/XHR; server-side not covered; the connection depends on the extension's service worker staying alive (WebSocket keepalive, Chrome 116+ ✅).

### Architecture 2: DevTools Protocol direct (no extension)

```
AI agent ──stdio──▶ MCP server ──DevTools Protocol WebSocket──▶ Chrome (real profile via 144+ auto-connect,
  (rules + log)        Fetch.enable / requestPaused /            or the agent-launched browser on a debugging port)
                       fulfillRequest / continueResponse         ──▶ local app / remote APIs
```

- **Where rules live:** in the MCP server process. The browser only sees paused requests.
- **How changes reach the browser:** immediately, because the MCP server evaluates every request itself.
- **For:** full fidelity, nothing to install, and it works with whatever browser the agent already controls.
- **Against:**
  - overrides disappear when the MCP process exits;
  - auto-connect's UX and how long a connection stays approved need validating ❓;
  - several DevTools clients intercepting the same tab may conflict ❓;
  - CORS headers and preflights become our job.

### Architecture 3: Proxy-first

```
AI agent ──stdio──▶ MCP server + embedded intercepting proxy (mockttp-style)
                           ▲                    ▲
     browser launched with  │                    │ dev-server process started with
     --proxy-server, <-loopback>,                │ HTTP(S)_PROXY, NODE_EXTRA_CA_CERTS, preload
     separate profile, SPKI cert allowlist       │
                           └──── both send traffic ───▶ upstream APIs
```

- **Where rules live:** in the MCP server (it *is* the proxy).
- **How changes reach the browser:** immediately.
- **For:** the only option that covers server-side requests, mobile and CLI tools; one engine for everything; full fidelity.
- **Against:**
  - certificate and proxy friction;
  - usually a separate browser profile instead of the developer's own;
  - the app's server has to be started with special environment variables;
  - HTTP Toolkit already occupies this space, with an MCP.

### Architecture 4: One rule engine, several adapters (hybrid)

```
                         ┌─▶ Extension adapter (real browser, low setup)                 [Arch 1]
AI agent ─▶ MCP server ──┼─▶ DevTools Protocol adapter (full fidelity / agent's browser)  [Arch 2]
  (single rule schema,   └─▶ Proxy adapter (server-side requests, opt-in)                [Arch 3]
   match log, repo files)
```

- **The rule format and the MCP tools are the product.** Adapters can be added over time, and each one reports which rule features it supports. For example, "body mocking: fetch/XHR only" for the extension adapter.
- **This is the most future-proof option,** and it avoids betting early on a single interception mechanism.
- **Risk:** scope creep. A first version should ship with one adapter.

**Leaning, not a decision:** the agent-first gap is in the *real browser plus a local control plane plus feedback*. That points toward starting with Architecture 1 or 2 behind the Architecture 4 interface, and leaving the proxy as a later opt-in for server-side requests. The choice between 1 and 2 depends mainly on the validation tests below: auto-connect UX, CDP coexistence, and extension pairing friction.

---

## 6. Assumptions and open questions to validate

1. **Chrome 144 auto-connect:** what the user sees; whether approval survives restarts; whether it shows an "automated software" bar; whether it works alongside Claude in Chrome or chrome-devtools-mcp attached to the same browser. ❓
2. **Two DevTools clients on the same tab:** can two clients both use the `Fetch` API (ours and Playwright's or DevTools'), or do they conflict? ❓
3. **Does `@playwright/mcp`'s `browser_route` work in `--extension` mode** (the user's real browser)? If it does, part of the gap is already closed. ❓
4. **The in-page patcher's early-request race:** can rules be in place *synchronously* before the page's first script runs, with no Requestly-style async injection? ❓
5. **DNR in practice:**
   - Does an update reliably apply to the very next request?
   - Do redirects to `data:` URLs or extension resources work for POST requests and requests with credentials?
   - Is the 5,000 limit on redirect/header rules ever a problem? ❓ / ⚠️
6. **Server-side request coverage:** how often do target users' bugs involve SSR or backend calls rather than browser fetches? This decides whether the proxy adapter is core or optional. Also check Node's built-in `fetch` proxy support in each version. ❓
7. **Chrome Web Store:** will an extension with `debugger` + `<all_urls>` + a localhost WebSocket pass review? Is installing from a sideloaded or unpacked build acceptable for an early beta? ❓
8. **Requestly reuse:** check the license of `requestly/interceptor`; decide whether to read/import Requestly rule JSON for migration. ❓
9. **Agent hosts:** how agents running in the cloud or a sandbox (not on the developer's machine) would reach a local browser, or whether that's out of scope. ❓
10. **Competition:** whether Google adds interception to chrome-devtools-mcp (#848), or Playwright MCP extends `browser_route`. Either would make the browser-side part of our product a commodity, leaving rules, scenarios and feedback as our differentiators.

---

## Key sources

- Requestly source: `github.com/requestly/interceptor` (`browser-extension/mv3/src/manifest.chrome.json`, `service-worker/services/rulesManager.ts`, `page-scripts/ajaxRequestInterceptor/*`, `app/src/modules/extension/mv3RuleParser/*`, `content-scripts/app/messageHandler.ts`), `requestly/http-interceptor-desktop-app`, `requestly/requestly-proxy`, `requestly/mcp`, `requestly/requestly-automation`. Docs: interceptor-docs.requestly.com.
- Chrome extension APIs: developer.chrome.com/docs/extensions/reference/api/{declarativeNetRequest, webRequest, debugger, scripting}; service worker lifecycle and WebSockets guides; native messaging; `debugger_api.cc` (infobar); chromium-extensions threads on `--load-extension` removal and LNA.
- developer.chrome.com/blog/local-network-access; /blog/remote-debugging-port; /docs/devtools/agents/use-cases/auto-connect.
- chromedevtools.github.io/devtools-protocol/tot/Fetch.
- Chromium `net/docs/proxy.md` (loopback bypass) and `ignore_errors_cert_verifier.cc`.
- MDN: `webRequest.filterResponseData`; browser-compat-data for DNR on Safari.
- Agent tools: github.com/microsoft/playwright-mcp; github.com/ChromeDevTools/chrome-devtools-mcp (tool reference, issue #848); docs.proxyman.com/mcp; httptoolkit.com/docs/guides/mcp; Fiddler Everywhere MCP docs; github.com/snapspecter/mitmproxy-mcp; github.com/JasonBoy/msw-mcp; mock-server.com AI/MCP docs; docs.wiremock.io/ai-mcp.
