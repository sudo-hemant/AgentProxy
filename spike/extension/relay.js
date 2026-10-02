// Extension content script (isolated world). The page wrapper can't call extension APIs,
// so this relays: rules from the service worker -> page, and match reports page -> service worker.
const pushRules = async () => {
  const rules = await chrome.runtime.sendMessage({ type: "get-page-rules" });
  window.postMessage({ __mockSpike: "rules", rules }, "*");
};

pushRules();
addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (e.data?.__mockSpike === "need-rules") pushRules();
  if (e.data?.__mockSpike === "match") {
    const { id, method, url, transport, operationName } = e.data;
    chrome.runtime.sendMessage({ type: "page-match", id, method, url, transport, operationName });
  }
});

// The service worker announces rule changes; re-fetch so open pages pick them up without a reload.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "rules-updated") pushRules();
});
