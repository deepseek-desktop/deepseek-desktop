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
  assert.match(menu, /#\[cfg\(target_os = "macos"\)\][\s\S]*?menu\.popup\(window\)/u);
  assert.match(menu, /#\[cfg\(not\(target_os = "macos"\)\)\][\s\S]*?menu\.popup_at\(/u);
  assert.match(runtime, /DESKTOP_MENU_WEBVIEW_LABEL/u);
  assert.match(runtime, /__DEEPSEEK_DESKTOP_MENU_ONLY__/u);
  assert.match(runtime, /WebviewUrl::App\("index\.html"\.into\(\)\)/u);
  assert.match(runtime, /Position::Logical/u);
  assert.match(runtime, /window_size\.to_logical::<f64>\(scale_factor\)/u);
  assert.match(runtime, /\.hide\(\)/u);
  assert.match(runtime, /should_navigate_workbench/u);
});

test("closing a view never shares the quit path", async () => {
  const lib = await readFile(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const menu = await readFile(new URL("../../src-tauri/src/native_menu.rs", import.meta.url), "utf8");
  // One window means window.close() quits, so the close item must not reach it.
  assert.doesNotMatch(lib, /CLOSE_MENU_ID \| native_menu::QUIT_MENU_ID/u);
  assert.match(lib, /CLOSE_MENU_ID => \{[\s\S]*?open_runtime\(\)/u);
  assert.match(lib, /QUIT_MENU_ID => \{[\s\S]*?window\.close\(\)/u);
  // The close item only exists while the settings layer is the closable surface.
  assert.match(menu, /if !workbench_visible \{[\s\S]*?CLOSE_MENU_ID/u);
  assert.match(menu, /close_settings/u);
});

test("the TaoView Objective-C guard tracks the macOS window state", async () => {
  const [lib, guard] = await Promise.all([
    readFile(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8"),
    readFile(new URL("../../src-tauri/src/tao_view_guard.rs", import.meta.url), "utf8")
  ]);
  assert.match(
    lib,
    /#\[cfg\(target_os = "macos"\)\]\s*mod tao_view_guard;/u
  );
  assert.match(lib, /tao_view_guard::install\(&window\)\?/u);
  assert.match(guard, /LIVE_VIEW_STATES/u);
  assert.match(guard, /state != registered_state/u);
  assert.match(guard, /msg_send!\[view, window\]/u);
});

test("macOS keeps native editing shortcuts available to the focused webview", async () => {
  const menu = await readFile(new URL("../../src-tauri/src/native_menu.rs", import.meta.url), "utf8");
  for (const action of ["undo", "redo", "cut", "copy", "paste", "select_all"]) {
    assert.match(menu, new RegExp(`PredefinedMenuItem::${action}\\(`, "u"));
  }
  assert.match(menu, /setAllowsKeyEquivalentWhenHidden\(true\)/u);
  assert.match(menu, /setHidden\(true\)/u);
});

test("menus and surface switches do not force focus during AppKit transitions", async () => {
  const [menu, runtime] = await Promise.all([
    readFile(new URL("../../src-tauri/src/native_menu.rs", import.meta.url), "utf8"),
    readFile(new URL("../../src-tauri/src/runtime.rs", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(menu, /set_focus\(\)/u);
  assert.doesNotMatch(runtime, /set_focus\(\)/u);
});
