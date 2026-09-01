import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("isolated workbench links reach the Rust navigation allowlist", async () => {
  const [app, lib, menu, runtime] = await Promise.all([
    readFile(resolve(root, "src/App.vue"), "utf8"),
    readFile(resolve(root, "src-tauri/src/lib.rs"), "utf8"),
    readFile(resolve(root, "src-tauri/src/native_menu.rs"), "utf8"),
    readFile(resolve(root, "src-tauri/src/runtime.rs"), "utf8")
  ]);
  assert.match(lib, /open_js_links_on_click\(false\)/u);
  assert.match(runtime, /\.on_navigation\(/u);
  assert.match(runtime, /\.on_new_window\(/u);
  assert.match(runtime, /\.opener\(\)\s*\.open_url\(/u);
  assert.doesNotMatch(runtime, /WORKBENCH_MENU_SCRIPT|__deepseek_desktop_menu__/u);
  assert.match(app, /DesktopMenuBar/u);
  assert.match(lib, /desktop_menu_popup/u);
  assert.match(menu, /WINDOW_MENU_HEIGHT_LOGICAL/u);
  assert.match(menu, /\.popup_at\(/u);
  assert.match(runtime, /DESKTOP_MENU_WEBVIEW_LABEL/u);
  assert.match(runtime, /__DEEPSEEK_DESKTOP_MENU_ONLY__/u);
  assert.match(runtime, /WebviewUrl::App\("index\.html"\.into\(\)\)/u);
  assert.match(runtime, /Position::Logical/u);
  assert.match(runtime, /window_size\.to_logical::<f64>\(scale_factor\)/u);
  assert.match(runtime, /\.hide\(\)/u);
  assert.match(runtime, /should_navigate_workbench/u);
});
