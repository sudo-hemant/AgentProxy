// Runs in the page's own JavaScript world at document_start, before the app's scripts, so the
// app only ever sees the wrapped fetch and XMLHttpRequest.
import { startPageWrapper } from "./page/start.js";

startPageWrapper(window);
