import { describe, expect, it } from "vitest";
import { parseExtensionToServer, parseServerToExtension } from "./bridge-protocol.js";

const json = (value: unknown) => JSON.stringify(value);

const match = {
  ruleId: "r1",
  method: "GET",
  url: "http://localhost:3000/api/orders",
  transport: "fetch",
};

describe("parseServerToExtension", () => {
  it("parses a rules message", () => {
    expect(parseServerToExtension(json({ type: "rules", version: 3, rules: [] }))).toEqual({
      type: "rules",
      version: 3,
      rules: [],
    });
  });

  it("rejects a rules message without a valid version or rule list", () => {
    expect(parseServerToExtension(json({ type: "rules", rules: [] }))).toBeUndefined();
    expect(parseServerToExtension(json({ type: "rules", version: -1, rules: [] }))).toBeUndefined();
    expect(
      parseServerToExtension(json({ type: "rules", version: 1.5, rules: [] })),
    ).toBeUndefined();
    expect(parseServerToExtension(json({ type: "rules", version: 1, rules: {} }))).toBeUndefined();
  });

  it("rejects messages meant for the server", () => {
    expect(parseServerToExtension(json({ type: "ping" }))).toBeUndefined();
  });
});

describe("parseExtensionToServer", () => {
  it("parses each message type", () => {
    expect(parseExtensionToServer(json({ type: "hello", protocolVersion: 1 }))).toEqual({
      type: "hello",
      protocolVersion: 1,
    });
    expect(parseExtensionToServer(json({ type: "applied", version: 7 }))).toEqual({
      type: "applied",
      version: 7,
    });
    expect(parseExtensionToServer(json({ type: "match", match }))).toEqual({
      type: "match",
      match,
    });
    expect(parseExtensionToServer(json({ type: "ping" }))).toEqual({ type: "ping" });
  });

  it("drops fields it doesn't know", () => {
    expect(parseExtensionToServer(json({ type: "ping", extra: true }))).toEqual({ type: "ping" });
  });

  it("rejects messages with missing or wrong fields", () => {
    expect(parseExtensionToServer(json({ type: "hello" }))).toBeUndefined();
    expect(parseExtensionToServer(json({ type: "applied", version: "7" }))).toBeUndefined();
    expect(parseExtensionToServer(json({ type: "match" }))).toBeUndefined();
    expect(
      parseExtensionToServer(json({ type: "match", match: { ...match, transport: "beacon" } })),
    ).toBeUndefined();
  });

  it("rejects unknown types and messages meant for the extension", () => {
    expect(parseExtensionToServer(json({ type: "shutdown" }))).toBeUndefined();
    expect(parseExtensionToServer(json({ type: "rules", version: 1, rules: [] }))).toBeUndefined();
  });

  it("rejects anything that isn't a JSON object", () => {
    expect(parseExtensionToServer("not json")).toBeUndefined();
    expect(parseExtensionToServer("null")).toBeUndefined();
    expect(parseExtensionToServer("[]")).toBeUndefined();
    expect(parseExtensionToServer('"ping"')).toBeUndefined();
  });
});
