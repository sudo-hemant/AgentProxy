// Stand-in for the MCP server. One process, one port (127.0.0.1:59999), three jobs:
//   1. WebSocket endpoint the extension connects to (rules are pushed down this).
//   2. /mock/:id — the URL the extension's DNR redirect points at; serves the mocked response.
//   3. /control/* — what the agent (MCP tools) would call. curl-able for the spike.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = 59999;
const PING_MS = Number(process.env.PING_MS ?? 20000); // 0 = extension sends no keepalive pings
// Spike-only "pairing": hand the token to the extension by writing it into the extension folder,
// reusing the existing one so a server restart doesn't force an extension reload.
// The real product needs a proper pairing flow.
const CONFIG_FILE = new URL("./extension/config.js", import.meta.url);
const existing = fs.existsSync(CONFIG_FILE) && fs.readFileSync(CONFIG_FILE, "utf8").match(/"token":"([0-9a-f]+)"/);
const TOKEN = existing ? existing[1] : crypto.randomBytes(16).toString("hex");
fs.writeFileSync(CONFIG_FILE, `export const CONFIG = ${JSON.stringify({ port: PORT, token: TOKEN })};\n`);

const rules = new Map(); // id -> { id, urlFilter, method, status, body, headers }
const matches = []; // every hit on /mock/:id
const events = []; // connection log: connects, rejects, disconnects, acks
let extSocket = null;
let lastAppliedVersion = 0;
let rulesVersion = 0;

const log = (e) => {
  events.push({ t: Date.now(), ...e });
  console.log("[server]", JSON.stringify(e));
};

const pushRules = () => {
  rulesVersion++;
  if (extSocket?.readyState === 1) {
    extSocket.send(JSON.stringify({ type: "rules", version: rulesVersion, rules: [...rules.values()] }));
  }
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

const corsHeaders = (req) => ({
  // Must echo the exact origin (not "*") so requests made with credentials: "include" are allowed.
  "Access-Control-Allow-Origin": req.headers.origin || "*",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
  Vary: "Origin",
});

const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // --- 2. Mock responses -------------------------------------------------------------
  if (url.pathname.startsWith("/mock/")) {
    const id = url.pathname.slice("/mock/".length);
    if (req.method === "OPTIONS") {
      matches.push({
        id,
        preflight: true,
        origin: req.headers.origin,
        requestedHeaders: req.headers["access-control-request-headers"] ?? null,
        t: Date.now(),
      });
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    const rule = rules.get(id);
    const body = await readBody(req);
    matches.push({
      id,
      method: req.method,
      receivedBody: body,
      contentType: req.headers["content-type"],
      origin: req.headers.origin,
      cookieHeader: req.headers.cookie ?? null,
      authorizationHeader: req.headers.authorization ?? null,
      via: "redirect",
      t: Date.now(),
    });
    if (!rule) return json(res, 410, { error: "rule gone" }, corsHeaders(req));
    res.writeHead(rule.status, {
      "Content-Type": "application/json",
      ...rule.headers,
      ...corsHeaders(req),
    });
    return res.end(typeof rule.body === "string" ? rule.body : JSON.stringify(rule.body));
  }

  // --- 3. Control API (what MCP tools would wrap) --------------------------------------
  if (url.pathname === "/control/rules" && req.method === "POST") {
    const rule = JSON.parse(await readBody(req));
    rule.id ??= crypto.randomBytes(4).toString("hex");
    rules.set(rule.id, rule);
    pushRules();
    return json(res, 200, { id: rule.id, version: rulesVersion });
  }
  if (url.pathname === "/control/rules" && req.method === "DELETE") {
    rules.clear();
    pushRules();
    return json(res, 200, { version: rulesVersion });
  }
  if (url.pathname === "/control/status") {
    return json(res, 200, {
      extensionConnected: extSocket?.readyState === 1,
      rulesVersion,
      lastAppliedVersion,
      matches,
      events,
    });
  }
  if (url.pathname === "/control/reset-log") {
    matches.length = 0;
    events.length = 0;
    return json(res, 200, {});
  }

  json(res, 404, { error: "not found" });
});

// --- 1. Extension WebSocket ------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin ?? "(none)";
  const token = new URL(req.url, "http://x").searchParams.get("token");
  // A web page can open ws://127.0.0.1 too; the browser stamps its real Origin, which it can't fake.
  if (!origin.startsWith("chrome-extension://") || token !== TOKEN) {
    log({ type: "ws-rejected", origin, tokenOk: token === TOKEN });
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    extSocket = ws;
    log({ type: "ws-connected", origin });
    ws.send(JSON.stringify({ type: "config", pingMs: PING_MS }));
    ws.send(JSON.stringify({ type: "rules", version: rulesVersion, rules: [...rules.values()] }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "applied") {
        lastAppliedVersion = msg.version;
        log({ type: "rules-applied", version: msg.version, count: msg.count, error: msg.error });
      } else if (msg.type === "hello") {
        log({ type: "ext-hello", swInstance: msg.swInstance });
      } else if (msg.type === "match") {
        // Mocks answered inside the page (fetch/XHR wrapper); the extension reports the hit here.
        matches.push({
          id: msg.id,
          method: msg.method,
          url: msg.url,
          transport: msg.transport,
          via: "page-wrapper",
          t: Date.now(),
        });
      } else if (msg.type === "ping") {
        // keepalive; nothing to do
      }
    });
    ws.on("close", () => {
      log({ type: "ws-closed" });
      if (extSocket === ws) extSocket = null;
    });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[server] listening on 127.0.0.1:${PORT} (PING_MS=${PING_MS})`));
