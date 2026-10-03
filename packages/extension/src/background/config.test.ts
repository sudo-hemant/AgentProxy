import { DEFAULT_PORT } from "@agentproxy/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const URL = "chrome-extension://id/config.json";

/** A fetch that serves `body` as the config file. */
const serve =
  (body: string, status = 200) =>
  async () =>
    new Response(body, { status });

describe("loadConfig", () => {
  it("reads the port and token", async () => {
    const config = await loadConfig(serve('{"port":5000,"token":"abc"}'), URL);
    expect(config).toEqual({ port: 5000, token: "abc" });
  });

  it("uses the default port when none is given", async () => {
    expect(await loadConfig(serve('{"token":"abc"}'), URL)).toEqual({
      port: DEFAULT_PORT,
      token: "abc",
    });
  });

  it("asks for the file at the given URL", async () => {
    let asked = "";
    await loadConfig(async (url) => {
      asked = url;
      return new Response('{"token":"abc"}');
    }, URL);
    expect(asked).toBe(URL);
  });

  describe("gives undefined", () => {
    it("when the file is missing", async () => {
      expect(await loadConfig(serve("", 404), URL)).toBeUndefined();
      expect(
        await loadConfig(() => Promise.reject(new TypeError("Failed to fetch")), URL),
      ).toBeUndefined();
    });

    it("when the file isn't a JSON object", async () => {
      expect(await loadConfig(serve("not json"), URL)).toBeUndefined();
      expect(await loadConfig(serve("null"), URL)).toBeUndefined();
    });

    it("without a token", async () => {
      expect(await loadConfig(serve('{"port":5000}'), URL)).toBeUndefined();
      expect(await loadConfig(serve('{"token":""}'), URL)).toBeUndefined();
      expect(await loadConfig(serve('{"token":42}'), URL)).toBeUndefined();
    });

    it("with a port that isn't valid", async () => {
      for (const port of [0, 65_536, 1.5, '"5000"']) {
        expect(await loadConfig(serve(`{"port":${port},"token":"abc"}`), URL)).toBeUndefined();
      }
    });
  });
});
