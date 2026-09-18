// Two tripwires for constraints that nothing else can catch.
//
// This file used to grep 15 Rust and Vue sources for 45 exact substrings — menu call
// shapes, a literal `38.0`, the body of `start()`. None of it ran any code, `cargo fmt`
// could break any of it, and the two cases that mattered most were already covered by real
// unit tests: `harness.rs` exercises the navigation allowlist (five tests) and
// `tao_view_guard.rs` exercises the AppKit guard (three). Those were removed.
//
// What remains is what a compiler and a unit test cannot express: two *negative*
// constraints, each with a crash or a data-loss incident behind it, and neither reachable
// from a test harness. They are cheap. Do not grow this file back into a source scanner —
// a behaviour worth pinning belongs in a Rust test that executes it.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("closing a view never shares the quit path", async () => {
  const lib = await readFile(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const menu = await readFile(new URL("../../src-tauri/src/native_menu.rs", import.meta.url), "utf8");
  // One window means window.close() quits, so the close item must not reach it.
  assert.doesNotMatch(lib, /CLOSE_MENU_ID \| native_menu::QUIT_MENU_ID/u);
  assert.match(lib, /CLOSE_MENU_ID => \{[\s\S]*?open_harness\(\)/u);
  assert.match(lib, /QUIT_MENU_ID => \{[\s\S]*?window\.close\(\)/u);
  // The close item only exists while the settings layer is the closable surface.
  assert.match(menu, /if !workbench_visible \{[\s\S]*?CLOSE_MENU_ID/u);
  assert.match(menu, /close_settings/u);
});

// ADR-019: macOS 26 kept delivering input to a TaoView whose window was already going
// away, and making a responder first during that transition aborted the process. Nothing
// observable distinguishes the safe path from the crashing one until it crashes.
test("menus and surface switches do not force focus during AppKit transitions", async () => {
  const [menu, harness] = await Promise.all([
    readFile(new URL("../../src-tauri/src/native_menu.rs", import.meta.url), "utf8"),
    readFile(new URL("../../src-tauri/src/harness.rs", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(menu, /set_focus\(\)/u);
  assert.doesNotMatch(harness, /set_focus\(\)/u);
});
