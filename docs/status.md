# AgentProxy — implementation status

Progress through the MVP steps in [plan.md](plan.md), and the decisions taken in each step.

| Step | State |
|---|---|
| 1. Project setup | ✅ Done |
| 2. Rule model | ✅ Done |
| 3. Extension core | ✅ Done |
| 4. Local bridge | ✅ Done |
| 5. MCP tools | ✅ Done |
| 6. Basic setup | ✅ Done |
| 7. End-to-end tests | Next |
| 8. Real-agent trial | In progress |

## Step 1: Project setup

**Result:** `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass on the skeleton. Each package has only placeholder code. The `e2e/` folder is created in step 7, when Playwright is added.

**Decisions:**
- **Tool versions:** TypeScript 7, Vitest 5, Biome 2.5, esbuild 0.28, pnpm 10. `@types/node` stays at 20 to match the Node 20+ minimum.
- **Root scripts:** `build`, `typecheck`, `lint`, `format` and `test`. `build` and `typecheck` run in each package in dependency order, so `shared` goes first.
- **TypeScript config:** one strict `tsconfig.base.json` that each package extends. It targets ES2022 with `NodeNext` modules and turns on `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- **`shared`** compiles with `tsc` to `dist/` with type declarations. The server and the extension both import that built output, which is why `shared` has to build first.
- **`server`** compiles with `tsc` and runs as the `agentproxy` command (`bin` → `dist/index.js`).
- **`extension`:**
  - `tsc` only type-checks it, with `Bundler` resolution and the DOM and `chrome` types.
  - `build.mjs` uses esbuild to bundle each entry point into its own self-contained script: `background.js`, `relay.js` and `page-wrapper.js`, targeting Chrome 120.
  - `build.mjs` also copies `static/manifest.json` into `dist/`. As in the spike, the manifest only covers `localhost` pages.
- **Tests:** one Vitest config at the root runs `packages/*/src/**/*.test.ts`. Tests sit next to the code they test, and the package builds leave them out.
- **Lint:** Biome checks the whole repo except `dist`, `node_modules` and `spike/`.
- **esbuild install script:** pnpm 10 blocks dependency install scripts by default, so esbuild's script is allowed in `pnpm-workspace.yaml`.

## Step 2: Rule model

**Result:** the rule types (`rule.ts`) and the matcher (`matcher.ts`) are in `shared`, with 38 unit tests covering every match type and the edge cases.

**Decisions:**
- **Rule shape:** `{ id, match: { url, method? }, response: { status, body?, headers? }, expiresAt }`.
  - `url` is one of `{ kind: "exact" | "wildcard" | "domain" | "regex", value }`. A regex can also take `flags`.
  - `expiresAt` is in epoch milliseconds.
  - The flat, agent-facing input for `set_mock` is defined in step 5 and converted to this shape.
- **Method:** compared without regard to case. If it's left out or set to `*`, it matches every method.
- **Exact:**
  - The scheme, host and port must all be the same. Host case and default ports are ignored, but path case counts.
  - The rule URL must be absolute.
- **Wildcard:**
  - `*` matches any characters, including `/`. Every other character is matched literally.
  - A pattern with no scheme applies to every scheme, so `api.example.com/*` covers both `http` and `https`.
  - Subdomains only match when the pattern says so, for example `https://*.example.com/*`.
- **Domain:** matches the host itself and every subdomain, but never a host that only ends with the same letters (`example.com` does not match `badexample.com`). Scheme, port, case, and a leading `.` or `*.` are ignored.
- **Regex:** tested against the full URL, including the query string. The `g` and `y` flags are dropped, because they make repeated tests give different answers. An invalid regex never matches.
- **Query strings** (exact and wildcard):
  - A rule that names no query matches the URL with any query.
  - With an exact rule that names a query, the request must have exactly those parameters, in any order.
  - A wildcard rule that names a query is matched against the query too.
- **Trailing slashes:** `/orders` and `/orders/` are treated as the same path in exact and wildcard rules, including at the root.
- **Hash:** always ignored, since browsers never send it.
- **When several rules match:** the most recently added rule that hasn't expired answers the request. A rule stops applying at its `expiresAt` time.
- **Validation:** `validateUrlMatcher` reports matchers that could never match: empty values, a relative exact URL, a domain with a scheme, port or path, and an invalid regex or flags. The server will use it in step 5 to reject bad rules.
- **No dependencies in `shared`:** the matcher gets bundled into the page wrapper, so `shared` uses only `URL`. Its TypeScript config uses the DOM types instead of the Node types, so no Node-only API slips in. Compiled globs and regexes are cached.

## Step 3: Extension core

**Result:** the extension mocks `fetch` and XHR (axios) in `localhost` pages. A Playwright test (`pnpm test:e2e`) loads the built extension in Chromium and confirms:
- requests made during page load are mocked;
- `fetch` and axios calls are mocked;
- requests that aren't mocked reach the real API with their `Authorization` header;
- rule changes reach an open page without a reload;
- match reports reach the background.

Until step 4, the rules are set directly in the service worker.

**How the pieces fit:**
- **Page wrapper** (`page-wrapper.ts` → `page/start.ts`): runs in the page's own world at `document_start` and replaces `fetch` and `XMLHttpRequest`. It's built from:
  - `page/rule-store.ts`, which holds the rules;
  - `page/fetch-wrapper.ts` and `page/xhr-wrapper.ts`;
  - `page/mock-response.ts`, which builds the mocked response.
- **Relay** (`relay.ts` → `relay/start.ts`): a content script in the extension's isolated world. It passes rules from the background into the page and match reports from the page to the background.
- **Background** (`background.ts` → `background/rules.ts`): keeps the rules, hands them to the relays, tells open tabs when they change, and keeps recent match reports.
- **Messages:** defined in `shared/src/messages.ts`.

Each piece's logic sits in a module that takes its browser APIs as arguments, so Vitest can test it without a browser. The entry files only wire those modules to the real APIs.

**Decisions:**
- **Waiting for rules:** requests wait for the first rule list, for up to 1 s, so mocks apply during page load without ever hanging the app.
  - A synchronous XHR can't wait. It's mocked only if the rules have already arrived.
  - Each new rule list replaces the old one.
- **Requests that aren't mocked:**
  - `fetch` gets the caller's exact original arguments.
  - An XHR is sent by the real `send` on the same object.
  - Nothing is copied or redirected, so login tokens and cookies are kept.
- **Mocked responses:**
  - A string body is sent as-is; anything else is sent as JSON.
  - `content-type` defaults to `application/json`. Header names are lower-cased.
  - Statuses 101, 103, 204, 205 and 304 get no body.
  - A mocked `fetch` response carries the request's URL.
- **XHR behaviour:**
  - The `""`, `text`, `json`, `blob` and `arraybuffer` response types are covered; `document` isn't.
  - Events fire after `send` returns for async requests, and before it returns for sync ones.
  - `abort()` on a request still waiting for the rules drops it and fires the abort events.
  - Calling `open()` again cancels a waiting send silently and clears any earlier mocked response.
- **Relative URLs** resolve against the page's current `document.baseURI`, which keeps them right after a single-page app changes its URL.
- **Page messages:** accepted only from the same window and origin, with our channel tag. Any script on the page can still post one, which is acceptable while only `localhost` is covered.
- **Rule replies in the relay:** if two requests for the rules overlap, only the newest reply is posted into the page.
- **Background storage:**
  - Rules live in `chrome.storage.session`, so they survive Chrome stopping the service worker.
  - The last 100 match reports are kept in memory only, and are lost when the worker stops. The server will keep matches from step 5.
- **Temporary scaffolding:** a demo rule (`GET /api/agentproxy-demo`) seeds an empty store, and the background is exposed as `globalThis.agentproxy` for the console and the e2e tests. Both go once the server drives the rules.
- **The spike's DNR redirect path** isn't ported. The overview ruled it out, because it drops the login token.
- **e2e tests:**
  - a separate workspace package in `e2e/`, using `@playwright/test`;
  - a test app on `localhost`, and a fake API on `127.0.0.1` on another port, so it's cross-origin like a real backend. The API echoes the `Authorization` header it received;
  - Chromium runs headless with `channel: "chromium"`, which can load extensions;
  - `pnpm test:e2e` builds everything first.

**Open items for later steps:**
- **Step 8:** check, in a normal Chrome, that the 20 s pings keep the service worker and the connection alive when idle. Automation keeps the worker awake, so the tests can't show this.
- **Workers:** requests made from web workers and service workers aren't covered, as noted in the overview.
- **Dependency warning:** Vitest asks for `@types/node` 22 or later as an optional peer, while the repo uses 20 to match the Node 20 minimum. It's a harmless install warning.

## Step 4: Local bridge

**Result:** the server and the extension talk over a WebSocket on `127.0.0.1`.
- The server pushes rules, and the extension confirms each version.
- Match reports flow back to the server.
- After a server restart, the extension reconnects and receives the new rules.

The e2e tests now set rules through a real server. New tests cover the confirmation, and mocking during and after a server restart (`e2e/tests/server-connection.spec.ts`). The server's start-up command is still a stub: step 5 starts the bridge alongside the MCP tools.

**How the pieces fit:**
- **Messages:** `shared/src/bridge-protocol.ts`.
  - Server → extension: `rules {version, rules}`.
  - Extension → server: `hello {protocolVersion}`, `applied {version}`, `match` and `ping`.
  - Both sides parse what they receive and drop anything malformed.
- **Server:**
  - `bridge.ts` listens on `127.0.0.1` and checks each connection.
  - `rule-sync.ts` sends rules and waits for confirmations.
  - `extension-connection.ts` tracks the connection: liveness, protocol version and match reports.
- **Extension:**
  - `background/config.ts` reads `config.json`.
  - `background/connection.ts` connects, applies and confirms rules, pings and reconnects.
  - `background.ts` wires these to Chrome.

**Decisions:**
- **Who may connect:** a WebSocket is accepted only if all three checks pass, otherwise the server answers 403.
  - The Origin is exactly `chrome-extension://hidhibepbghhdfljdadfhcgkgjngeocm`.
  - The pairing token is right. It's compared in constant time.
  - The Host is `127.0.0.1` or `localhost` with the server's port, which blocks DNS rebinding.
- **Fixed extension ID:** the manifest carries a public `key`, so the ID is the same on every machine. Only the public key is in the repo; an extension loaded from a folder needs no private key. A unit test checks that the key and the `EXTENSION_ID` constant match, and Chrome was confirmed to assign that ID. The Chrome Web Store will assign its own ID later.
- **Default port:** `47821` (`DEFAULT_PORT`).
- **The extension finds the server through `config.json`** (`{ port, token }`) in its folder. The build doesn't create it but keeps an existing one across rebuilds. Step 6 makes the server write it; the e2e tests write their own into a copy of the extension.
- **The server is the source of truth for rules:**
  - Every change gets a new version, and a newly connected extension gets the current list straight away.
  - `setRules` reports `applied: true` once the extension confirms that version or a newer one. It reports `applied: false` if no extension is connected, or if there's no confirmation within 5 s.
  - The extension applies rule lists in the order they arrive. It doesn't confirm a list it failed to store.
- **While the server is down,** the extension keeps its last rules, so pages stay mocked until the rules expire. On reconnect, the server's list replaces them. A restarted server starts with no rules.
- **Keeping the connection alive:**
  - The extension pings every 20 s, which also keeps Chrome from stopping the service worker.
  - The server drops a connection that's silent for 60 s.
  - The extension reconnects 1 s after a drop.
  - An alarm every 30 s, the shortest Chrome allows, restarts the worker and the connection if Chrome stopped them anyway. This needs the `alarms` permission.
- **One extension at a time:** a newer connection replaces an older one, for example after the extension is reloaded.
- **Protocol mismatch:** the server closes with code 4000. The extension then retries only when the alarm next fires, not every second.
- **Matches go to the server.** The background passes each one on and keeps none. Reports made while disconnected are lost.
- **Scaffolding removed:** the demo rule and the `globalThis.agentproxy` debug handle are gone.

## Step 5: MCP tools

**Result:** the `agentproxy` command serves five tools over stdio: `set_mock`, `list_mocks`, `clear_mocks`, `get_matches` and `status`.

Browser tests (`e2e/tests/agent-tools.spec.ts`) drive the real extension through an MCP client:
- set a mock and see the page get it;
- find the request in `get_matches`;
- clear the mock and see the real API answer again;
- watch a 2-second mock expire on its own.

`e2e/tests/cli.spec.ts` starts the built command over stdio, checks its tools, and checks that it exits on its own when the agent closes stdin.

**How the pieces fit** (all in `packages/server/src`):
- **`index.ts`:** the command. It reads its settings, starts everything, logs only to stderr and exits when stdin closes.
- **`settings.ts`:** reads `AGENTPROXY_PORT` and `AGENTPROXY_TOKEN`.
- **`main.ts`:** `startAgentProxy` wires everything together over any MCP transport.
- **`mcp.ts`:** the five tools.
- **`mock-input.ts`:** the `set_mock` input schema and its checks.
- **`mock-store.ts`:** the live mocks.
- **`match-log.ts`:** recent matches.

**Decisions:**
- **`set_mock` input is flat.** Only `url` is required. The other fields are `match_type`, `regex_flags`, `method`, `status`, `body`, `headers`, `expires_in_seconds` and `id`. The field descriptions explain the behaviour, because they're what the agent reads.
- **Defaults:**
  - `match_type` is `wildcard`.
  - `status` is 200. It must be 200–599, because a browser `Response` can't be built with anything else.
  - A mock expires after 600 s, at most 86400 s, so an agent can't leave mocks behind for long.
  - A mock without an `id` gets a generated one.
- **Ids:** setting a mock with an existing `id` replaces it, and the replacement becomes the newest. When several mocks match a request, the newest wins.
- **Bad URL patterns are rejected up front:** a relative exact URL, a domain with a path, an invalid regex, or `regex_flags` without `match_type: regex`.
- **Every change sends the browser the full list of live mocks.** Each reply says whether the browser confirmed it (`applied`), with a note on what to do next: it's active, open Chrome with the extension, or check `get_matches`.
- **No timer pushes expiries to the browser.** Both sides ignore expired mocks by the clock, and the next change sends the cleaned-up list.
- **`list_mocks`** reports mocks with the same field names `set_mock` takes, plus when they expire.
- **`clear_mocks`** clears everything, or the given `ids`, and reports any ids it didn't find.
- **`get_matches`:**
  - returns the most recent 50 matches by default, at most 500, oldest first, with the total;
  - can filter by `mock_id`, and by `since` as an ISO timestamp;
  - when nothing matched, its note says to reload the page and check the pattern.
- **The match log** keeps the last 500 matches, in memory only.
- **`status`** reports:
  - whether the extension is connected;
  - the port, or why the server couldn't listen;
  - the number of live mocks and the version;
  - a note on what to do next.
- **If the port is taken,** for example by a second agent session, the tools still start: `set_mock` reports `applied: false`, and `status` explains the problem and how to use another port.
- **Tool replies are JSON in a text block,** which every MCP client can read.
- **Settings:**
  - `AGENTPROXY_PORT` defaults to 47821, and 0 picks a free port.
  - `AGENTPROXY_TOKEN` is random for each run if unset. Step 6 keeps it across restarts and writes it to the extension's `config.json`.
- **Package exports:** the server package exports `agentproxy/bridge` and `agentproxy/main` for the e2e fixtures.

## Step 6: Basic setup

**Result:** from a fresh clone, `pnpm install` and `pnpm run setup` build everything, pair the extension and register the server with Claude Code. After that you load `packages/extension/dist` in Chrome, and the agent can use the tools. The README describes these steps.

I followed the README from a fresh clone of the repo, with two stand-ins:
- `--no-register`, so the real Claude Code config wasn't touched;
- Playwright's Chromium, loading the clone's `dist` folder as-is, instead of your Chrome.

An MCP client then started the clone's server exactly as Claude Code would. The extension connected, a `GET /api/orders` mock reached the page, `get_matches` reported it, and `clear_mocks` brought back the real API. The `claude mcp add` arguments were checked against the real CLI at project scope in a scratch folder.

**How the pieces fit:**
- **`server/src/pairing.ts`:** reads and writes the extension's `config.json`.
- **`server/src/setup.ts`:** `agentproxy setup`, which checks the build, pairs, registers and prints next steps.
- **`server/src/index.ts`:** chooses between serving MCP (no arguments) and `setup`.
- **`server/bin/agentproxy.js`:** a committed launcher for the built command.
- **`extension/src/background/connection.ts`:** now loads the config before every connection attempt.

**Decisions:**
- **The pairing lives in one place:** the extension's `config.json` (`{ port, token }`).
  - The server reuses the token in it on every start, so restarting the server never breaks the pairing.
  - The token comes from `AGENTPROXY_TOKEN` if set, otherwise from `config.json`, otherwise a new random one.
  - The server writes the actual port and the token once its bridge listens, and only when they changed.
  - Nothing is written outside the repo.
- **Extension folder:** the built extension next to the server in the repo, or `AGENTPROXY_EXTENSION_DIR`. If it can't be written, for example because it isn't built, the server still runs and `status` says what to do.
- **The extension re-reads `config.json` before every connection attempt,** and keeps looking every second while it's missing. Chrome serves an unpacked extension's files from disk, so an extension loaded before pairing, or after a port or token change, connects without a reload. This was checked in Chromium and is covered by a browser test.
- **`agentproxy setup`:**
  - checks the extension is built;
  - pairs it on the configured port, refusing port 0;
  - registers the server with Claude Code: `claude mcp add agentproxy --scope user [-e AGENTPROXY_PORT=…] -- <node> <server>`.
- **Registration details:**
  - It uses absolute paths to `node` and the server, so it doesn't depend on the agent's `PATH`.
  - An earlier registration is removed first, so setup can be run again.
  - The scope can be changed with `--scope local|project`.
  - Without the `claude` command, setup prints an `mcpServers` entry for other MCP clients.
  - `--no-register` only pairs.
- **`pnpm run setup`** builds, then runs `agentproxy setup`, passing its arguments through.
- **Shutdown:** the server stops when stdin ends, once. The CLI test fails on any error output from the command.

**Problems found while following the README, and fixed:**
- **Install warning:** a fresh `pnpm install` warned that it couldn't create the `agentproxy` bin, because the bin pointed at `dist/`, which doesn't exist before the first build. A committed launcher, `bin/agentproxy.js`, fixes it.
- **Crash on disconnect:** the server overflowed the stack when the agent disconnected. Overriding the transport's `onclose` replaced the MCP SDK's handler, and closing called shutdown again.
- **Registration order:** `claude mcp add` put `-e` before the server name. `-e` takes several values, so it could swallow the name.

## Step 8: Real-agent trial

**In progress.** Step 7 isn't finished yet, but the trial started early, once the server was registered with Claude Code.

**Trial 1 (2026-10-03):**
- **The app:** an existing Vite app on `http://localhost:5173`, in the user's own Chrome, with the extension loaded from `packages/extension/dist`.
- **What it calls:** a third-party API from the browser, `GET https://dummyjson.com/products/1`.
- **The agent:** Claude Code, set up through `pnpm run setup` at user scope.
- **What worked, with no help beyond the prompts:**
  - `status` reported the extension connected.
  - `set_mock` changed what the page showed after a reload.
  - A mock with a short `expires_in_seconds` expired on its own, and the real API answered again.
  - `list_mocks`, `get_matches` and `clear_mocks` worked as described.
- **Problems found:** none.

**Still to check:**
- **Idle Chrome:** leave a normal Chrome idle for 10 minutes or more, then set a mock. This confirms the 20 s pings and the 30 s alarm keep the connection alive (the open item from step 3).
- **Login:** an app that sends a login token or cookies, to confirm unmocked requests stay logged in outside the test app.
