#!/usr/bin/env node
// Committed launcher for the `agentproxy` command, so the bin exists before the first build
// (pnpm links bins at install time). The command itself is the built dist/index.js.
import "../dist/index.js";
