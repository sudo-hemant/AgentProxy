# AgentProxy — build plan

This plan covers the MVP only. Features after the MVP are listed in [overview.md](overview.md#features) and will be planned once the MVP works.

## Tech stack

- **TypeScript** for every package. The server and the extension share the rule types and the matching code, so a rule means the same thing on both sides.
- **pnpm workspaces** to keep everything in one repo.
- **AgentProxy server:**
  - Node.js 20+.
  - The official MCP SDK (`@modelcontextprotocol/sdk`), talking to the agent over stdio.
  - `ws` for the extension connection.
  - `zod` to validate tool inputs.
  - Published to npm as `agentproxy`, so it runs with `npx agentproxy`.
- **Extension:** Chrome Manifest V3, bundled with esbuild.
- **Tests:** Vitest for unit tests, Playwright for end-to-end tests with a real browser and the extension loaded.
- **Lint and format:** Biome.

## Folder structure

```
agentproxy/
├── packages/
│   ├── shared/       # @agentproxy/shared: rule types, URL/method matcher, server⇄extension messages
│   ├── server/       # agentproxy: MCP tools + local WebSocket bridge to the extension
│   └── extension/    # @agentproxy/extension: service worker, relay, in-page fetch/XHR wrapper
├── e2e/              # Playwright tests: test app, fake external API, scenarios
├── docs/             # research, overview, this plan
└── spike/            # proof of concept, kept for reference until the MVP replaces it
```

## MVP steps

Each step ends with something that runs and is tested.

1. **Project setup.** Create the pnpm workspace, TypeScript config, esbuild build for the extension, Biome, and Vitest. *Done when* `pnpm build`, `pnpm lint` and `pnpm test` pass on an empty skeleton.

2. **Rule model.** Define the mock rule shape in `shared`:
   - **What to match:** exact URL, wildcard pattern, domain, or regex, plus the method.
   - **What to return:** status, body, and headers.
   - **Lifetime:** an expiry time.

   Write the matcher that decides whether a request matches a rule. *Done when* unit tests cover every match type and the edge cases: query strings, trailing slashes, subdomains.

3. **Extension core.** Port the spike's extension to TypeScript:
   - the background script that receives rules
   - the relay that passes rules into pages
   - the page wrapper for `fetch` and `XMLHttpRequest`

   Requests wait for the rules on page load, and rule changes reach open pages without a reload. *Done when* the extension, loaded with hard-coded rules, mocks both `fetch` and axios calls, and requests that aren't mocked keep their login token.

4. **Local bridge.** Add the server's WebSocket endpoint for the extension:
   - accept only our extension's origin, and only with the pairing token
   - send a keepalive ping every 20 seconds
   - reconnect automatically if the connection drops

   *Done when* the extension connects, receives rules, confirms them, and reconnects after the server restarts.

5. **MCP tools.** Expose the tools to the agent:
   - `set_mock`
   - `list_mocks`
   - `clear_mocks`
   - `get_matches`, which reports which requests hit which mock
   - `status`, which reports whether the extension is connected

   Mocks expire on their own. *Done when* the tools can be called from an MCP client and each change reaches the browser.

6. **Basic setup.** Keep the spike's simple pairing, where the server writes the token for an extension loaded from a local folder. Add the one command that registers the server with an agent. Write a short README. *Done when* someone can follow the README from a fresh clone to a working mock.

7. **End-to-end tests.** Build a Playwright suite from the spike's test app and fake external API. It covers:
   - `fetch` and axios mocks
   - mocks applying on page load
   - requests that aren't mocked keeping auth
   - live rule updates
   - the security checks on the local port

   It also measures how long pages wait for the rules on load. *Done when* the suite runs green with one command.

8. **Real-agent trial.** Use AgentProxy from Claude Code on a sample app across a few realistic scenarios, and fix what gets in the way. Also run the idle check in a normal Chrome, to confirm the connection survives without automation keeping the worker awake. *Done when* an agent can set a mock, verify it, and clear it without help.
