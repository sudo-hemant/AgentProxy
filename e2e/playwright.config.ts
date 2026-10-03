import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  // One browser with the extension at a time: each test gets its own, but they start slowly.
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
});
