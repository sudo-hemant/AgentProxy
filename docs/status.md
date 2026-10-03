# AgentProxy — implementation status

Progress through the MVP steps in [plan.md](plan.md), and the decisions taken in each step.

| Step | State |
|---|---|
| 1. Project setup | ✅ Done |
| 2. Rule model | ✅ Done |
| 3. Extension core | ✅ Done |
| 4. Local bridge | Next |
| 5. MCP tools | Not started |
| 6. Basic setup | Not started |
| 7. End-to-end tests | Not started |
| 8. Real-agent trial | Not started |

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
- **Step 5:** `set_mock` must reject response statuses outside 200–599, because a browser `Response` can't be built with them.
- **Workers:** requests made from web workers and service workers aren't covered, as noted in the overview.
- **Dependency warning:** Vitest asks for `@types/node` 22 or later as an optional peer, while the repo uses 20 to match the Node 20 minimum. It's a harmless install warning.
