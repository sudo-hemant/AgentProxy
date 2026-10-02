// Connects OUT to the local server (extensions can't listen on ports) and receives rules.
// Default path: rules are handed to the in-page wrapper (mock-wrapper.js), which answers
// fetch/XHR calls inside the page — unmocked requests keep their auth headers.
// Rules with via: "redirect" instead become DNR session rules that redirect the request to
// http://127.0.0.1:<port>/mock/<ruleId> (kept from spike 1 for comparison).
import { CONFIG } from "./config.js";

const SW_INSTANCE = Math.random().toString(36).slice(2, 8); // changes if Chrome restarts the worker
const MOCK_BASE = `http://127.0.0.1:${CONFIG.port}/mock/`;
let ws = null;
let pingTimer = null;

async function applyRules(version, allRules) {
  // Stored in session storage so a restarted worker can still answer the page immediately.
  const pageRules = allRules.filter((r) => r.via !== "redirect");
  const rules = allRules.filter((r) => r.via === "redirect");
  await chrome.storage.session.set({ pageRules });
  broadcastToTabs({ type: "rules-updated" });

  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const addRules = rules.map((r, i) => ({
    id: i + 1,
    priority: 1,
    action: { type: "redirect", redirect: { url: MOCK_BASE + r.id } },
    condition: {
      urlFilter: r.urlFilter,
      requestMethods: [r.method.toLowerCase()],
      resourceTypes: ["xmlhttprequest"], // fetch() and XHR both count as xmlhttprequest
      initiatorDomains: ["localhost"], // only requests made by the dev app's pages
    },
  }));
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules,
    });
    send({ type: "applied", version, count: addRules.length + pageRules.length });
  } catch (e) {
    send({ type: "applied", version, count: 0, error: String(e) });
  }
}

// Pages that are already open re-fetch rules, so a rule change applies without a reload.
async function broadcastToTabs(msg) {
  for (const tab of await chrome.tabs.query({})) {
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {}); // tabs without our content script
  }
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`ws://127.0.0.1:${CONFIG.port}/?token=${CONFIG.token}`);
  ws.onopen = () => send({ type: "hello", swInstance: SW_INSTANCE });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "config") {
      clearInterval(pingTimer);
      // Since Chrome 116, WebSocket traffic resets the service worker's 30s idle timer.
      if (msg.pingMs > 0) pingTimer = setInterval(() => send({ type: "ping" }), msg.pingMs);
    } else if (msg.type === "rules") {
      applyRules(msg.version, msg.rules);
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    setTimeout(connect, 1000);
  };
}

// Messages from relay.js (the content script bridging the in-page wrapper).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get-page-rules") {
    chrome.storage.session.get("pageRules").then(({ pageRules }) => sendResponse(pageRules ?? []));
    return true; // async response
  }
  if (msg.type === "page-match") {
    send({ type: "match", id: msg.id, method: msg.method, url: msg.url, transport: msg.transport, operationName: msg.operationName });
  }
});

// If Chrome does kill the worker, the alarm wakes it and we reconnect (minimum period is 30s).
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
connect();
