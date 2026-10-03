import { EventEmitter } from "node:events";
import { CLOSE_PROTOCOL_MISMATCH, type MatchReport, PROTOCOL_VERSION } from "@agentproxy/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionTracker, type TrackedSocket } from "./extension-connection.js";

/** A fake extension connection. close and terminate emit "close", as a real socket would. */
function fakeSocket() {
  const emitter = new EventEmitter();
  const socket = {
    send: vi.fn(),
    on: (event: string, listener: (...args: never[]) => void) => emitter.on(event, listener),
    close: vi.fn(() => {
      emitter.emit("close");
    }),
    terminate: vi.fn(() => {
      emitter.emit("close");
    }),
  } satisfies TrackedSocket;
  return {
    socket,
    say: (message: unknown) => emitter.emit("message", Buffer.from(JSON.stringify(message))),
  };
}

const match: MatchReport = {
  ruleId: "r1",
  method: "GET",
  url: "http://localhost:3000/api/orders",
  transport: "xhr",
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createConnectionTracker", () => {
  describe("isConnected", () => {
    it("is false until an extension connects, and after it disconnects", () => {
      const tracker = createConnectionTracker();
      expect(tracker.isConnected()).toBe(false);
      const ext = fakeSocket();
      tracker.accept(ext.socket);
      expect(tracker.isConnected()).toBe(true);
      ext.socket.close();
      expect(tracker.isConnected()).toBe(false);
    });
  });

  describe("a newer connection", () => {
    it("closes the older one and stays connected", () => {
      const tracker = createConnectionTracker();
      const older = fakeSocket();
      const newer = fakeSocket();
      tracker.accept(older.socket);
      tracker.accept(newer.socket);
      expect(older.socket.close).toHaveBeenCalledWith(1000, "replaced by a newer connection");
      expect(tracker.isConnected()).toBe(true);
    });
  });

  describe("silence", () => {
    it("drops a connection that sends nothing for the timeout", () => {
      const tracker = createConnectionTracker({ silenceTimeoutMs: 1000 });
      const ext = fakeSocket();
      tracker.accept(ext.socket);
      vi.advanceTimersByTime(999);
      expect(ext.socket.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ext.socket.terminate).toHaveBeenCalled();
      expect(tracker.isConnected()).toBe(false);
    });

    it("keeps a connection that pings", () => {
      const tracker = createConnectionTracker({ silenceTimeoutMs: 1000 });
      const ext = fakeSocket();
      tracker.accept(ext.socket);
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(800);
        ext.say({ type: "ping" });
      }
      expect(ext.socket.terminate).not.toHaveBeenCalled();
      expect(tracker.isConnected()).toBe(true);
    });

    it("defaults to 60 seconds", () => {
      const ext = fakeSocket();
      createConnectionTracker().accept(ext.socket);
      vi.advanceTimersByTime(59_999);
      expect(ext.socket.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ext.socket.terminate).toHaveBeenCalled();
    });
  });

  describe("hello", () => {
    it("keeps an extension that speaks our protocol version", () => {
      const ext = fakeSocket();
      createConnectionTracker().accept(ext.socket);
      ext.say({ type: "hello", protocolVersion: PROTOCOL_VERSION });
      expect(ext.socket.close).not.toHaveBeenCalled();
    });

    it("closes an extension that speaks another protocol version", () => {
      const tracker = createConnectionTracker();
      const ext = fakeSocket();
      tracker.accept(ext.socket);
      ext.say({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1 });
      expect(ext.socket.close).toHaveBeenCalledWith(
        CLOSE_PROTOCOL_MISMATCH,
        `server speaks protocol v${PROTOCOL_VERSION}`,
      );
      expect(tracker.isConnected()).toBe(false);
    });
  });

  describe("match reports", () => {
    it("are passed to onMatch", () => {
      const onMatch = vi.fn();
      const ext = fakeSocket();
      createConnectionTracker({ onMatch }).accept(ext.socket);
      ext.say({ type: "match", match });
      expect(onMatch).toHaveBeenCalledWith(match);
    });

    it("are dropped when malformed", () => {
      const onMatch = vi.fn();
      const ext = fakeSocket();
      createConnectionTracker({ onMatch }).accept(ext.socket);
      ext.say({ type: "match", match: { ruleId: "r1" } });
      expect(onMatch).not.toHaveBeenCalled();
    });
  });
});
