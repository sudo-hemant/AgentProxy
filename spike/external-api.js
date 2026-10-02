// Simulates the team's real backend on its own HTTPS domain (https://api.example.test:4443).
// The test browser maps api.example.test to 127.0.0.1. Every response says whether the
// Authorization header arrived, so the spike can tell if a technique breaks auth.
import https from "node:https";
import fs from "node:fs";
import { execSync } from "node:child_process";

const PORT = 4443;
const CERT_DIR = new URL("./certs/", import.meta.url).pathname;

if (!fs.existsSync(`${CERT_DIR}/key.pem`)) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=api.example.test" ` +
      `-addext "subjectAltName=DNS:api.example.test" -keyout ${CERT_DIR}/key.pem -out ${CERT_DIR}/cert.pem`,
    { stdio: "ignore" }
  );
}

const cors = (req) => ({
  "Access-Control-Allow-Origin": req.headers.origin || "*",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
});

const server = https.createServer(
  { key: fs.readFileSync(`${CERT_DIR}/key.pem`), cert: fs.readFileSync(`${CERT_DIR}/cert.pem`) },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      return res.end();
    }
    let body = "";
    for await (const c of req) body += c;
    const auth = req.headers.authorization ?? null;
    res.writeHead(200, { "Content-Type": "application/json", ...cors(req) });

    if (req.url === "/orders") {
      return res.end(JSON.stringify({ source: "REAL external API", auth }));
    }
    if (req.url === "/graphql") {
      const { operationName } = JSON.parse(body || "{}");
      return res.end(JSON.stringify({ data: { source: "REAL external API", operationName, auth } }));
    }
    res.end(JSON.stringify({ error: "not found" }));
  }
);

server.listen(PORT, "127.0.0.1", () => console.log(`[external-api] listening on https://api.example.test:${PORT}`));
