import assert from "node:assert/strict";
import test from "node:test";

import { assertPrebuildPlatform, prebuildArtifactDeclarations } from "../lib/native-prebuilds.mjs";

test("normalizes the Harness binary declaration format", () => {
  assert.deepEqual(prebuildArtifactDeclarations({
    platform: "linux-x64",
    binaries: [{ kind: "static-musl", path: "bin/landlock-run" }]
  }, "@deepseek-ai/system-linux-x64"), [
    { kind: "static-musl", path: "bin/landlock-run" }
  ]);
});

test("normalizes the official LibreOffice native engine declaration", () => {
  const sha256 = "a".repeat(64);
  assert.deepEqual(prebuildArtifactDeclarations({
    schemaVersion: 1,
    platform: "darwin-arm64",
    engine: { kind: "native", executable: "bin/libreoffice-kit" },
    files: { "bin/libreoffice-kit": sha256 }
  }, "@deepseek-ai/libreoffice-kit-darwin-arm64"), [
    { kind: "native-engine", path: "bin/libreoffice-kit", sha256 }
  ]);
});

test("accepts the official portable WASM engine on a Linux target", () => {
  const sha256 = "b".repeat(64);
  const prebuilds = {
    schemaVersion: 1,
    platform: "wasm",
    engine: {
      kind: "wasm",
      loader: "assets/soffice.cjs",
      wasm: "assets/soffice.wasm",
      data: "assets/soffice.data",
      metadata: "assets/soffice.data.js.metadata"
    },
    files: {
      "assets/soffice.cjs": sha256,
      "assets/soffice.wasm": sha256,
      "assets/soffice.data": sha256,
      "assets/soffice.data.js.metadata": sha256
    }
  };
  const artifacts = prebuildArtifactDeclarations(prebuilds, "@deepseek-ai/libreoffice-kit-wasm");

  assert.equal(artifacts.length, 4);
  assert.ok(artifacts.every(artifact => artifact.kind === "wasm-engine-file"));
  assert.doesNotThrow(() => assertPrebuildPlatform(
    prebuilds,
    artifacts,
    new Set(["linux-x64", "linux-x64-gnu"]),
    "@deepseek-ai/libreoffice-kit-wasm"
  ));
});

test("rejects an undeclared or unhashed native engine executable", () => {
  assert.throws(() => prebuildArtifactDeclarations({
    schemaVersion: 1,
    engine: { kind: "native", executable: "bin/libreoffice-kit" },
    files: {}
  }, "@deepseek-ai/libreoffice-kit-darwin-arm64"), /no SHA-256 declaration/u);
  assert.throws(() => prebuildArtifactDeclarations({ platform: "darwin-arm64" }, "unknown-native"), /no supported executable declarations/u);
});
