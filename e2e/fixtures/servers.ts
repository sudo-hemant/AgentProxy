// The two servers the tests run against: the developer's app on localhost, and its backend on
// another origin. Both listen on a free port picked by the OS.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/**
 * The fake backend, on 127.0.0.1 so it is cross-origin to the app. Every response says which
 * path was asked for and which Authorization header arrived, so tests can tell a real response
 * from a mock and check that auth was kept.
 */
export function startApi(): Promise<RunningServer> {
  return listen(
    createServer((req, res) => {
      const cors = {
        "Access-Control-Allow-Origin": req.headers.origin ?? "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(
        JSON.stringify({ source: "real", path: req.url, auth: req.headers.authorization ?? null }),
      );
    }),
    "127.0.0.1",
    (port) => `http://127.0.0.1:${port}`,
  );
}

/**
 * The developer's app on localhost, where the extension runs. Its page loads axios, then calls
 * the API from <head>, as early as an app's own startup code would, and keeps the result in
 * `window.onLoadResult`.
 */
export async function startApp(apiUrl: string): Promise<RunningServer> {
  // axios's exports map hides its browser build, so locate it through package.json.
  const axiosDir = dirname(createRequire(import.meta.url).resolve("axios/package.json"));
  const axiosSource = await readFile(join(axiosDir, "dist/axios.min.js"), "utf8");
  const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>AgentProxy test app</title>
<script src="/axios.js"></script>
<script>
  window.API = ${JSON.stringify(apiUrl)};
  window.TOKEN = "Bearer test-token";
  window.onLoadResult = fetch(API + "/orders", { headers: { Authorization: TOKEN } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
</script></head>
<body><h1>AgentProxy test app</h1></body></html>`;

  return listen(
    createServer((req, res) => {
      if (req.url === "/axios.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" }).end(axiosSource);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(page);
    }),
    "localhost",
    (port) => `http://localhost:${port}`,
  );
}

function listen(
  server: Server,
  host: string,
  toUrl: (port: number) => string,
): Promise<RunningServer> {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: toUrl(port),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
