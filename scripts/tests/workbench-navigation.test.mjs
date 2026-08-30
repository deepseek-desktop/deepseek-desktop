import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("isolated workbench links reach the Rust navigation allowlist", async () => {
  const [lib, runtime] = await Promise.all([
    readFile(resolve(root, "src-tauri/src/lib.rs"), "utf8"),
    readFile(resolve(root, "src-tauri/src/runtime.rs"), "utf8")
  ]);
  assert.match(lib, /open_js_links_on_click\(false\)/u);
  assert.match(runtime, /\.on_navigation\(/u);
  assert.match(runtime, /\.on_new_window\(/u);
  assert.match(runtime, /\.opener\(\)\s*\.open_url\(/u);
});
