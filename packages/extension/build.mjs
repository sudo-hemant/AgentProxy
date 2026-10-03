// Bundles each extension entry point into dist/ and copies the static files (manifest) next to them.
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist";
// Written by the server, not the build: keep it, so rebuilding doesn't undo the pairing.
const configFile = `${outdir}/config.json`;

const config = await readFile(configFile, "utf8").catch(() => undefined);
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
if (config !== undefined) await writeFile(configFile, config);
