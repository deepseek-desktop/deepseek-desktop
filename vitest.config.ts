import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "jsdom",
    clearMocks: true
  }
});
