// Bundles each extension entry point into dist/ and copies the static files (manifest) next to them.
import { cp, rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: {
    background: "src/background.ts",
    relay: "src/relay.ts",
    "page-wrapper": "src/page-wrapper.ts",
  },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
});
await cp("static", outdir, { recursive: true });
