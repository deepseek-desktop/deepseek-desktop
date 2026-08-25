import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const appConfig = JSON.parse(readFileSync(resolve(import.meta.dirname, "target/generated/app-config.json"), "utf8")) as Record<string, unknown>;

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_CONFIG__: JSON.stringify(appConfig)
  },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "jsdom",
    clearMocks: true
  }
});
