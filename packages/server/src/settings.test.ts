import { resolve } from "node:path";
import { DEFAULT_PORT } from "@agentproxy/shared";
import { describe, expect, it } from "vitest";
import { readSettings } from "./settings.js";

const DEFAULT_DIR = "/repo/packages/extension/dist";

describe("readSettings", () => {
  it("uses the default port and extension folder, and no forced token, when nothing is set", () => {
    expect(readSettings({}, DEFAULT_DIR)).toEqual({
      port: DEFAULT_PORT,
      token: undefined,
      extensionDir: DEFAULT_DIR,
    });
  });

  it("reads the port, token and extension folder", () => {
    const env = {
      AGENTPROXY_PORT: "5000",
      AGENTPROXY_TOKEN: "abc",
      AGENTPROXY_EXTENSION_DIR: "/somewhere/else",
    };
    expect(readSettings(env, DEFAULT_DIR)).toEqual({
      port: 5000,
      token: "abc",
      extensionDir: "/somewhere/else",
    });
  });

  it("makes a relative extension folder absolute", () => {
    const { extensionDir } = readSettings({ AGENTPROXY_EXTENSION_DIR: "ext" }, DEFAULT_DIR);
    expect(extensionDir).toBe(resolve("ext"));
  });

  it("allows port 0, which picks a free port", () => {
    expect(readSettings({ AGENTPROXY_PORT: "0" }, DEFAULT_DIR).port).toBe(0);
  });

  it("treats empty values as unset", () => {
    const env = { AGENTPROXY_PORT: "", AGENTPROXY_TOKEN: "", AGENTPROXY_EXTENSION_DIR: "" };
    expect(readSettings(env, DEFAULT_DIR)).toEqual({
      port: DEFAULT_PORT,
      token: undefined,
      extensionDir: DEFAULT_DIR,
    });
  });

  it("rejects a port that isn't a port number", () => {
    for (const value of ["abc", "-1", "1.5", "65536", "80 "]) {
      expect(() => readSettings({ AGENTPROXY_PORT: value }, DEFAULT_DIR)).toThrow(
        /AGENTPROXY_PORT/,
      );
    }
  });
});
