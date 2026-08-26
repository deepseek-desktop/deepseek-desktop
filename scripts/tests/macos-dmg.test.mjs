import test from "node:test";
import assert from "node:assert/strict";
import { macDmgFilename } from "../macos-dmg.mjs";

test("builds deterministic macOS DMG names", () => {
  assert.equal(
    macDmgFilename("DeepSeek Desktop", "1.0.0", "aarch64"),
    "DeepSeek Desktop_1.0.0_aarch64.dmg"
  );
  assert.equal(
    macDmgFilename("DeepSeek Desktop", "1.0.0", "x64"),
    "DeepSeek Desktop_1.0.0_x64.dmg"
  );
});

test("rejects unsupported macOS DMG architectures", () => {
  assert.throws(
    () => macDmgFilename("DeepSeek Desktop", "1.0.0", "universal"),
    /unsupported macOS DMG architecture/u
  );
});
