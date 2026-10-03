# AgentProxy — implementation status

Progress through the MVP steps in [plan.md](plan.md), and the decisions taken in each step.

| Step | State |
|---|---|
| 1. Project setup | ✅ Done |
| 2. Rule model | ✅ Done |
| 3. Extension core | Next |
| 4. Local bridge | Not started |
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
