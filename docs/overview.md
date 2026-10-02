# AgentProxy — overview

## What we are building

AgentProxy lets an AI coding agent mock the API responses of a web app running on a developer's machine, without the developer configuring anything by hand.

Today, testing a scenario like "the orders API returns a 500" or "the list comes back empty" means opening a tool like Requestly and setting up the rule manually. An agent cannot do that itself. AgentProxy gives the agent tools to do it directly: the agent sets a mock, reloads the page, checks the result, and the mock expires on its own.

## Target user and constraints

- Developers running their frontend locally (for example on `localhost:3000`) that calls their backend hosted on its own domain.
- Works with any frontend framework, because it intercepts at the browser level, not inside the app's code.
- No changes to the app's code.
- Minimal setup: install a Chrome extension, add one MCP server to the agent's config.
- Works in Chrome, the developer's own browser.

## How it works

There are three pieces:

```
AI agent ──(MCP, stdio)──► AgentProxy server (local Node process)
                                   ▲
                                   │ WebSocket on 127.0.0.1, opened by the extension
                                   │
                           Chrome extension ──► page wrapper inside the app's page
```

1. **The AgentProxy server** is an MCP server the agent starts on the developer's machine. It gives the agent tools such as `set_mock` and `get_matches`, and it holds the active mocks.
2. **The Chrome extension** connects to the server over a local WebSocket. An extension cannot accept incoming connections, so it is always the one that connects out. It receives the mocks and passes them into the app's pages.
3. **The page wrapper** is a small script the extension injects into the app's page before the app's own code runs. It replaces the browser's `fetch` and `XMLHttpRequest`. When the app makes a request that matches a mock, the wrapper returns the mocked response without touching the network. Every other request goes out unchanged, with its login token and cookies intact.

## What the exploration showed

The research is in [research.md](research.md). The proof of concept is in [`spike/`](../spike/).

**Existing tools don't cover this.** Requestly has an MCP server, but it writes rules to Requestly's cloud, and they only reach the browser when Requestly's web app syncs them. Playwright MCP can mock responses, but only in the separate browser it launches. Proxy tools (Proxyman, HTTP Toolkit) need a certificate installed and the traffic routed through them.

**Two ways to mock inside the browser were tested:**

| | Redirect (Chrome's built-in rules send the request to our local server) | Page wrapper (replace `fetch`/XHR inside the page) |
|---|---|---|
| Mocks apply on page load | Yes | Yes, because the wrapper waits up to 1s for the rules |
| Calls to the backend's own domain | Needs extension permission for each domain | No extra permission |
| Login token on requests that aren't mocked | **Lost.** The browser strips `Authorization` on redirects, so partial mocking and passing requests through break | **Kept.** Requests that aren't mocked go out untouched |
| Can match on the request body (GraphQL) | No | Yes |
| Shows in DevTools Network tab | Yes, as a redirect | No |

**Decision: use the page wrapper.** The redirect approach breaks authentication for every request that isn't mocked, which rules it out as the main path.

**Also verified:**
- The extension connects to the local server and applies rule changes in about 50 ms.
- The server rejects WebSocket connections from websites and from anything without the pairing token.

**Not verified yet:**
- XHR support in the wrapper. It is written but not tested.
- How long a page waits for the rules on load.
- Whether Chrome suspends the extension's background worker when idle in a normal browser. The automated test couldn't check this, because the automation tool kept the worker awake.

## Features

**MVP:**
- Agent tools: set a mock, list mocks, clear mocks, see which requests matched which mock, and check whether the extension is connected.
- Match requests by exact URL, wildcard pattern, domain, or regex, combined with the HTTP method.
- A mock returns a status, a body, and headers.
- Works for both `fetch` and `XMLHttpRequest`, so axios is covered.
- Mocks expire automatically.
- Rule changes reach open pages without a reload.

**Later (not planned in detail yet):**
- GraphQL mocks by operation name. Already proven in the spike.
- Modifying a real response instead of replacing it.
- A proper pairing and setup flow for the Chrome Web Store version.
- Saving mock scenarios as files in the repo.
- Matching on request headers or body.
- Server-side requests, such as SSR. These need a proxy, because they never pass through the browser.
- Firefox and Safari.

## Known limitations

- Only requests made through `fetch` or `XMLHttpRequest` in the page are mocked. Images, scripts, and requests from web workers or service workers are not.
- Mocked requests don't appear in the DevTools Network tab.
- Only pages on `localhost` are covered in the MVP.
