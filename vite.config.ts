import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const generatedConfigPath = resolve(import.meta.dirname, "target/generated/app-config.json");

function loadAppConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(generatedConfigPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`run \`pnpm app:sync\` before starting Vite: ${String(error)}`);
  }
}

function appTitle(productName: string): Plugin {
  return {
    name: "deepseek-desktop-app-title",
    transformIndexHtml(html) {
      return html.replace(/<title>.*?<\/title>/u, `<title>${productName}</title>`);
    }
  };
}

export default defineConfig(() => {
  const appConfig = loadAppConfig();
  const productName = String(appConfig.productName);
  return {
    plugins: [vue(), appTitle(productName)],
    define: {
      __APP_CONFIG__: JSON.stringify(appConfig)
    },
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true
    },
    envPrefix: ["VITE_", "TAURI_"]
  };
});
