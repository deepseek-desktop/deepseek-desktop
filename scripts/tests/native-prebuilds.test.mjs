import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNativeArtifactModes,
  assertPrebuildPlatform,
  prebuildArtifactDeclarations
} from "../lib/native-prebuilds.mjs";

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

test("a POSIX launcher must carry the execute bit in both the file and the manifest", () => {
  const artifact = { kind: "native-engine", path: "bin/engine", sha256: "a".repeat(64) };
  const context = { stagedPath: "node_modules/pkg/bin/engine", executableBitIsMeaningful: true };
  assert.doesNotThrow(() => assertNativeArtifactModes(artifact, 0o755, { mode: 0o755 }, context));
  assert.throws(
    () => assertNativeArtifactModes(artifact, 0o644, { mode: 0o755 }, context),
    /launcher is not executable/u
  );
  assert.throws(
    () => assertNativeArtifactModes(artifact, 0o755, { mode: 0o644 }, context),
    /omits the executable mode/u
  );
  // The stager records a mode on POSIX, so its absence there is a real gap.
  assert.throws(
    () => assertNativeArtifactModes(artifact, 0o755, {}, context),
    /omits the executable mode/u
  );
});

test("a Windows launcher is accepted without any mode, which NTFS does not carry", () => {
  const artifact = { kind: "native-engine", path: "bin/engine.exe", sha256: "a".repeat(64) };
  const context = {
    stagedPath: "node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe",
    executableBitIsMeaningful: false
  };
  // Node reports no execute bit on Windows and the stager records no mode at all.
  assert.doesNotThrow(() => assertNativeArtifactModes(artifact, 0o666, {}, context));
  assert.doesNotThrow(() => assertNativeArtifactModes(artifact, 0o666, { sha256: "b".repeat(64) }, context));
});

test("a WASM module needs no execute bit and a missing manifest record always fails", () => {
  const wasm = { kind: "wasm-engine-file", path: "assets/soffice.wasm", sha256: "c".repeat(64) };
  for (const executableBitIsMeaningful of [true, false]) {
    const context = { stagedPath: "node_modules/pkg/assets/soffice.wasm", executableBitIsMeaningful };
    assert.doesNotThrow(() => assertNativeArtifactModes(wasm, 0o644, { mode: 0o644 }, context));
    assert.throws(
      () => assertNativeArtifactModes(wasm, 0o644, undefined, context),
      /omits the native artifact/u
    );
  }
});
