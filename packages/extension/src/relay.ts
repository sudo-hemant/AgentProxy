// Runs as a content script in the extension's isolated world, alongside the page wrapper.
import type { RelayRuntime } from "./relay/start.js";
import { startRelay } from "./relay/start.js";

startRelay(window, chrome.runtime as unknown as RelayRuntime);
