import { EventEmitter } from "node:events";
import type { MockRule, ServerToExtension } from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuleSync, type ExtensionSocket } from "./rule-sync.js";

const rule = (id: string): MockRule => ({
  id,
  match: { url: { kind: "wildcard", value: "*/api/orders" } },
  response: { status: 500 },
  expiresAt: Number.MAX_SAFE_INTEGER,
});

/** A fake extension connection that records what the server sends it. */
function fakeSocket() {
  const emitter = new EventEmitter();
  const sent: ServerToExtension[] = [];
  const socket: ExtensionSocket = {
    send: (data) => sent.push(JSON.parse(data)),
    on: (event: string, listener: (...args: never[]) => void) => emitter.on(event, listener),
  };
  return {
    socket,
    sent,
    reply: (message: unknown) => emitter.emit("message", Buffer.from(JSON.stringify(message))),
    close: () => emitter.emit("close"),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createRuleSync", () => {
  it("sends the current rules to an extension as soon as it connects", async () => {
    const sync = createRuleSync();
    await sync.setRules([rule("a")]);
    const ext = fakeSocket();
    sync.attach(ext.socket);
    expect(ext.sent).toEqual([{ type: "rules", version: 1, rules: [rule("a")] }]);
  });

  it("starts at version 0 with no rules", () => {
    const ext = fakeSocket();
    createRuleSync().attach(ext.socket);
    expect(ext.sent).toEqual([{ type: "rules", version: 0, rules: [] }]);
  });

  it("sends each change with a new version, and resolves once the extension confirms it", async () => {
    const sync = createRuleSync();
    const ext = fakeSocket();
    sync.attach(ext.socket);

    const pending = sync.setRules([rule("a")]);
    expect(ext.sent.at(-1)).toEqual({ type: "rules", version: 1, rules: [rule("a")] });
    ext.reply({ type: "applied", version: 1 });
    expect(await pending).toEqual({ version: 1, applied: true });
    expect(sync.getRules()).toEqual([rule("a")]);
  });

  it("reports not applied when no extension is connected", async () => {
    const sync = createRuleSync();
    expect(await sync.setRules([rule("a")])).toEqual({ version: 1, applied: false });
    expect(sync.getRules()).toEqual([rule("a")]); // kept for when the extension connects
  });

  it("reports not applied when the extension doesn't confirm in time", async () => {
    const sync = createRuleSync({ ackTimeoutMs: 500 });
    sync.attach(fakeSocket().socket);
    const pending = sync.setRules([rule("a")]);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ version: 1, applied: false });
  });

  it("treats confirming a newer version as confirming the older ones", async () => {
    const sync = createRuleSync();
    const ext = fakeSocket();
    sync.attach(ext.socket);
    const first = sync.setRules([rule("a")]);
    const second = sync.setRules([rule("b")]);
    ext.reply({ type: "applied", version: 2 });
    expect(await first).toEqual({ version: 1, applied: true });
    expect(await second).toEqual({ version: 2, applied: true });
  });

  it("doesn't settle a newer version on an older confirmation", async () => {
    const sync = createRuleSync({ ackTimeoutMs: 500 });
    const ext = fakeSocket();
    sync.attach(ext.socket);
    sync.setRules([rule("a")]);
    const second = sync.setRules([rule("b")]);
    ext.reply({ type: "applied", version: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await second).toEqual({ version: 2, applied: false });
  });

  it("ignores messages that aren't valid", async () => {
    const sync = createRuleSync({ ackTimeoutMs: 500 });
    const ext = fakeSocket();
    sync.attach(ext.socket);
    const pending = sync.setRules([rule("a")]);
    ext.reply({ type: "applied", version: "1" });
    ext.reply("garbage");
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ version: 1, applied: false });
  });

  it("stops sending to an extension once it disconnects", async () => {
    const sync = createRuleSync();
    const ext = fakeSocket();
    sync.attach(ext.socket);
    ext.close();
    expect(await sync.setRules([rule("a")])).toEqual({ version: 1, applied: false });
    expect(ext.sent).toHaveLength(1); // only the rules sent on connect
  });
});
