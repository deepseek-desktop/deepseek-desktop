import { defineConfig } from "@playwright/test";

const port = Number(process.env.DEEPSEEK_DESKTOP_E2E_PORT || "1421");
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("pnpm executable is unavailable");
const quote = (value: string): string => `"${value.replaceAll("\"", "\\\"")}"`;
const pnpm = `${quote(process.execPath)} ${quote(pnpmCli)}`;
const noProxy = new Set((process.env.NO_PROXY || process.env.no_proxy || "").split(",").filter(Boolean));
noProxy.add("127.0.0.1");
noProxy.add("localhost");
process.env.NO_PROXY = [...noProxy].join(",");
process.env.no_proxy = process.env.NO_PROXY;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.CI ? undefined : "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: `${pnpm} build && ${pnpm} exec vite preview --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000
  }
});
