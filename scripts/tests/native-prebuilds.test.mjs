import assert from "node:assert/strict";
import test from "node:test";

import { nativeExecutableDeclarations } from "../lib/native-prebuilds.mjs";

test("normalizes the Harness binary declaration format", () => {
  assert.deepEqual(nativeExecutableDeclarations({
    platform: "linux-x64",
    binaries: [{ kind: "static-musl", path: "bin/landlock-run" }]
  }, "@deepseek-ai/system-linux-x64"), [
    { kind: "static-musl", path: "bin/landlock-run" }
  ]);
});

test("normalizes the official LibreOffice native engine declaration", () => {
  const sha256 = "a".repeat(64);
  assert.deepEqual(nativeExecutableDeclarations({
    schemaVersion: 1,
    platform: "darwin-arm64",
    engine: { kind: "native", executable: "bin/libreoffice-kit" },
    files: { "bin/libreoffice-kit": sha256 }
  }, "@deepseek-ai/libreoffice-kit-darwin-arm64"), [
    { kind: "native-engine", path: "bin/libreoffice-kit", sha256 }
  ]);
});

test("rejects an undeclared or unhashed native engine executable", () => {
  assert.throws(() => nativeExecutableDeclarations({
    schemaVersion: 1,
    engine: { kind: "native", executable: "bin/libreoffice-kit" },
    files: {}
  }, "@deepseek-ai/libreoffice-kit-darwin-arm64"), /no SHA-256 declaration/u);
  assert.throws(() => nativeExecutableDeclarations({ platform: "darwin-arm64" }, "unknown-native"), /no supported executable declarations/u);
});
