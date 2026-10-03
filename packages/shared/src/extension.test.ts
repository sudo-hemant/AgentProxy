import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "./extension.js";

const manifestPath = new URL("../../extension/static/manifest.json", import.meta.url);

/** Chrome's rule: the first 32 hex digits of the key's SHA-256, written with letters a–p. */
function extensionIdFromKey(base64Key: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex");
  return [...hex.slice(0, 32)]
    .map((d) => String.fromCharCode(97 + Number.parseInt(d, 16)))
    .join("");
}

describe("EXTENSION_ID", () => {
  it("is the ID Chrome gives the extension for its manifest key", () => {
    const { key } = JSON.parse(readFileSync(manifestPath, "utf8")) as { key: string };
    expect(extensionIdFromKey(key)).toBe(EXTENSION_ID);
  });

  it("makes the extension origin", () => {
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}`);
  });
});
