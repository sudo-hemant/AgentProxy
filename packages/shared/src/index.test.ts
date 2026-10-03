import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.js";

describe("shared", () => {
  it("exports a protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
