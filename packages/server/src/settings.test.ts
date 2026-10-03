import { DEFAULT_PORT } from "@agentproxy/shared";
import { describe, expect, it } from "vitest";
import { readSettings } from "./settings.js";

describe("readSettings", () => {
  it("uses the default port and a random token when nothing is set", () => {
    const settings = readSettings({});
    expect(settings.port).toBe(DEFAULT_PORT);
    expect(settings.token).toMatch(/^[0-9a-f]{32}$/);
    expect(readSettings({}).token).not.toBe(settings.token);
  });

  it("reads the port and token", () => {
    expect(readSettings({ AGENTPROXY_PORT: "5000", AGENTPROXY_TOKEN: "abc" })).toEqual({
      port: 5000,
      token: "abc",
    });
  });

  it("allows port 0, which picks a free port", () => {
    expect(readSettings({ AGENTPROXY_PORT: "0" }).port).toBe(0);
  });

  it("treats empty values as unset", () => {
    const settings = readSettings({ AGENTPROXY_PORT: "", AGENTPROXY_TOKEN: "" });
    expect(settings.port).toBe(DEFAULT_PORT);
    expect(settings.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a port that isn't a port number", () => {
    for (const value of ["abc", "-1", "1.5", "65536", "80 "]) {
      expect(() => readSettings({ AGENTPROXY_PORT: value })).toThrow(/AGENTPROXY_PORT/);
    }
  });
});
