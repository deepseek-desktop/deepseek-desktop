import test from "node:test";
import assert from "node:assert/strict";
import { macDmgFilename } from "../macos-dmg.mjs";

test("builds deterministic macOS DMG names", () => {
  assert.equal(
    macDmgFilename("DeepSeek Desktop", "0.1.6.1", "aarch64"),
    "DeepSeek Desktop_0.1.6.1_aarch64.dmg"
  );
  assert.equal(
    macDmgFilename("DeepSeek Desktop", "0.1.6.1", "x64"),
    "DeepSeek Desktop_0.1.6.1_x64.dmg"
  );
});

test("rejects unsupported macOS DMG architectures", () => {
  assert.throws(
    () => macDmgFilename("DeepSeek Desktop", "0.1.6.1", "universal"),
    /unsupported macOS DMG architecture/u
  );
});
