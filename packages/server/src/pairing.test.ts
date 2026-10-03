import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, readPairing, writePairing } from "./pairing.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproxy-pairing-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fileContents = async () => JSON.parse(await readFile(configPath(dir), "utf8"));

describe("readPairing", () => {
  it("is undefined when there is no config.json", async () => {
    expect(await readPairing(dir)).toBeUndefined();
  });

  it("reads the port and token", async () => {
    await writeFile(configPath(dir), '{"port":5000,"token":"abc"}');
    expect(await readPairing(dir)).toEqual({ port: 5000, token: "abc" });
  });

  it("is undefined when the file is unusable", async () => {
    await writeFile(configPath(dir), "not json");
    expect(await readPairing(dir)).toBeUndefined();
    await writeFile(configPath(dir), '{"port":5000}');
    expect(await readPairing(dir)).toBeUndefined();
  });

  it("is undefined when the folder doesn't exist", async () => {
    expect(await readPairing(join(dir, "missing"))).toBeUndefined();
  });
});

describe("writePairing", () => {
  it("writes config.json when there is none", async () => {
    expect(await writePairing(dir, { port: 5000, token: "abc" })).toBe(true);
    expect(await fileContents()).toEqual({ port: 5000, token: "abc" });
  });

  it("leaves the file alone when it already holds this pairing", async () => {
    await writePairing(dir, { port: 5000, token: "abc" });
    expect(await writePairing(dir, { port: 5000, token: "abc" })).toBe(false);
  });

  it("rewrites the file when the port or token changed", async () => {
    await writePairing(dir, { port: 5000, token: "abc" });
    expect(await writePairing(dir, { port: 6000, token: "abc" })).toBe(true);
    expect(await writePairing(dir, { port: 6000, token: "xyz" })).toBe(true);
    expect(await fileContents()).toEqual({ port: 6000, token: "xyz" });
  });

  it("replaces an unusable file", async () => {
    await writeFile(configPath(dir), "not json");
    expect(await writePairing(dir, { port: 5000, token: "abc" })).toBe(true);
    expect(await readPairing(dir)).toEqual({ port: 5000, token: "abc" });
  });

  it("fails when the folder doesn't exist", async () => {
    await expect(writePairing(join(dir, "missing"), { port: 1, token: "t" })).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
