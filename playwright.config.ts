import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const port = Number(process.env.DEEPSEEK_DESKTOP_E2E_PORT || "1421");
const quote = (value: string): string => `"${value.replaceAll("\"", "\\\"")}"`;
const pnpm = `${quote(process.execPath)} ${quote(resolve("scripts/with-pnpm.mjs"))}`;
const noProxy = new Set((process.env.NO_PROXY || process.env.no_proxy || "").split(",").filter(Boolean));
noProxy.add("127.0.0.1");
noProxy.add("localhost");
process.env.NO_PROXY = [...noProxy].join(",");
process.env.no_proxy = process.env.NO_PROXY;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  projects: [
    { name: "chromium", use: { channel: process.env.CI ? undefined : "chrome" } },
    ...(process.platform === "darwin" ? [{
      name: "webkit",
      testMatch: /harness-values\.spec\.ts/,
      use: { browserName: "webkit" as const }
    }] : [])
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: `${pnpm} frontend:build && ${pnpm} exec vite preview --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000
  }
});
