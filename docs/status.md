# AgentProxy — implementation status

Progress through the MVP steps in [plan.md](plan.md), and the decisions taken in each step.

| Step | State |
|---|---|
| 1. Project setup | ✅ Done |
| 2. Rule model | Next |
| 3. Extension core | Not started |
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
