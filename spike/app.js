// The "developer's app" on localhost:3000, with a real /api/orders backend.
// The page fires its API calls from an inline <head> script, i.e. as early as an SPA bootstrap
// would, so the spike also checks that mocks apply to the very first requests on page load.
import http from "node:http";

const PORT = 3000;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Spike app</title>
<script>
window.__results = {};
const done = [];
const record = (name, p) => done.push(p.then(
  (v) => (window.__results[name] = v),
  (e) => (window.__results[name] = { error: String(e) })
));
const describe = async (r) => ({
  status: r.status, redirected: r.redirected, url: r.url, body: await r.text(),
});

// 1. GET with cookies (credentials: include), fired immediately on page load.
record("fetchGet", fetch("/api/orders", { credentials: "include" }).then(describe));

// 2. POST with a JSON body (non-simple request => browser sends a CORS preflight after redirect).
record("fetchPost", fetch("/api/orders", {
  method: "POST", credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ item: "book", qty: 2 }),
}).then(describe));

// 3. XHR (what axios uses).
record("xhrGet", new Promise((resolve) => {
  const x = new XMLHttpRequest();
  x.open("GET", "/api/orders");
  x.withCredentials = true;
  x.onload = () => resolve({ status: x.status, url: x.responseURL, body: x.responseText });
  x.onerror = () => resolve({ error: "xhr network error" });
  x.send();
}));

// 4. A web page trying to talk to the local control port. Must NOT get through.
record("pageWebSocket", new Promise((resolve) => {
  const ws = new WebSocket("ws://127.0.0.1:59999/?token=guessed");
  ws.onopen = () => resolve({ opened: true });
  ws.onerror = () => resolve({ opened: false });
}));

Promise.all(done).then(() => {
  window.__done = true;
  const show = () => (document.getElementById("out").textContent = JSON.stringify(window.__results, null, 2));
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", show) : show();
});
</script></head>
<body><h1>Spike app</h1><pre id="out">running…</pre></body></html>`;

// Page 2: the realistic case — the localhost app calls the team's backend on another HTTPS domain,
// authenticating with a bearer token. All calls fire from <head> (page-load timing).
const API = "https://api.example.test:4443";
const externalPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Spike app — external API</title>
<script>
window.__results = {};
const done = [];
const record = (name, p) => done.push(p.then(
  (v) => (window.__results[name] = v),
  (e) => (window.__results[name] = { error: String(e) })
));
const describe = async (r) => ({ status: r.status, redirected: r.redirected, url: r.url, body: await r.text() });
const AUTH = { Authorization: "Bearer real-user-token" };
const gql = (operationName) => fetch("${API}/graphql", {
  method: "POST",
  headers: { ...AUTH, "Content-Type": "application/json" },
  body: JSON.stringify({ operationName, query: "query " + operationName + " { x }", variables: {} }),
}).then(describe);

record("restGet", fetch("${API}/orders", { headers: AUTH }).then(describe));
record("gqlGetOrders", gql("GetOrders")); // has a mock
record("gqlGetUser", gql("GetUser"));     // no mock: must reach the real API with auth intact

Promise.all(done).then(() => {
  window.__done = true;
  const show = () => (document.getElementById("out").textContent = JSON.stringify(window.__results, null, 2));
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", show) : show();
});
</script></head>
<body><h1>Spike app — external API</h1><pre id="out">running…</pre></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/external") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(externalPage);
  }
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "session=real-user; Path=/" });
    return res.end(page);
  }
  if (req.url === "/api/orders") {
    let body = "";
    for await (const c of req) body += c;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ source: "REAL backend", method: req.method, received: body || null }));
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "localhost", () => console.log(`[app] listening on http://localhost:${PORT}`));
