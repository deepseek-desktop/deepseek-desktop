import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { artifactName, assertSemVer, compareSemVer, hostTarget, isPrereleaseSemVer, parseArguments, sha256, supportedTargets } from "../runtime-update/common.mjs";

const root = resolve(import.meta.dirname, "../..");

test("maps only native Runtime update targets", () => {
  assert.equal(hostTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(hostTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => hostTarget("linux", "arm64"), /unsupported/u);
});

test("builds stable artifact names and validates SemVer", () => {
  assert.equal(
    artifactName("1.0.0", "x86_64-unknown-linux-gnu"),
    "deepseek-runtime_1.0.0_x86_64-unknown-linux-gnu.tar.gz"
  );
  assert.equal(assertSemVer("1.0.0-preview.1", "version"), "1.0.0-preview.1");
  assert.throws(() => assertSemVer("latest", "version"), /SemVer/u);
  assert.equal(compareSemVer("1.0.0-preview.2", "1.0.0-preview.10"), -1);
  assert.equal(compareSemVer("1.0.0", "1.0.0-preview.10"), 1);
  assert.equal(compareSemVer("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(isPrereleaseSemVer("1.0.0+build-linux"), false);
  assert.equal(isPrereleaseSemVer("1.0.0-preview.1+build-linux"), true);
});

test("parses explicit maintainer arguments", () => {
  assert.deepEqual(
    Object.fromEntries(parseArguments(["--channel", "preview", "--output", "release"])),
    { channel: "preview", output: "release" }
  );
  assert.deepEqual(
    Object.fromEntries(parseArguments(["--", "--output", "release"])),
    { output: "release" }
  );
  assert.throws(() => parseArguments(["--channel"]), /invalid argument/u);
});

test("creates a signed manifest only from a complete clean native target set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-runtime-manifest-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = join(directory, "signing.pem");
    await writeFile(key, privateKey.export({ format: "pem", type: "pkcs8" }));
    const desktopCommit = "a".repeat(40);
    const runtimeCommit = "b".repeat(40);
    for (const target of Object.values(supportedTargets)) {
      const artifact = artifactName("1.0.0", target);
      const artifactPath = join(directory, artifact);
      await writeFile(artifactPath, `runtime-${target}`);
      await writeFile(join(directory, `runtime-update-descriptor.${target}.json`), JSON.stringify({
        schemaVersion: 1,
        runtimeVersion: "1.0.0",
        runtimeCommit,
        runtimeRepository: "https://example.invalid/runtime.git",
        runtimeDirty: false,
        desktopCommit,
        desktopDirty: false,
        target,
        runtimeProtocolVersion: 1,
        credentialProtocolVersion: 1,
        credentialProviderVersion: "1.0.0",
        marketVersion: "1.0.0",
        nodeVersion: "24.16.0",
        nodeModuleAbi: "137",
        artifact: {
          file: artifact,
          size: Buffer.byteLength(`runtime-${target}`),
          sha256: await sha256(artifactPath)
        }
      }));
    }
    const output = join(directory, "manifest.json");
    const result = spawnSync(process.execPath, [
      "scripts/runtime-update/manifest.mjs",
      "--directory", directory,
      "--signing-key", key,
      "--base-url", "https://updates.example.com/runtime/",
      "--allowed-origins", "https://cdn.example.com:443",
      "--output", output
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(await readFile(output, "utf8"));
    const payload = Buffer.from(envelope.signedPayload, "base64");
    assert.equal(
      verify(null, payload, publicKey, Buffer.from(envelope.signature, "base64")),
      true
    );
    const manifest = JSON.parse(payload.toString("utf8"));
    assert.deepEqual(Object.keys(manifest.artifacts).sort(), Object.values(supportedTargets).sort());
    assert.equal(manifest.desktopCommit, desktopCommit);
    assert.ok(Date.parse(manifest.expiresAt) > Date.parse(manifest.issuedAt));
    assert.deepEqual(manifest.allowedOrigins, ["https://cdn.example.com"]);
    assert.match(manifest.artifacts[Object.values(supportedTargets)[0]].url, /^https:\/\/updates\.example\.com\/runtime\//u);

    const invalidRange = spawnSync(process.execPath, [
      "scripts/runtime-update/manifest.mjs",
      "--directory", directory,
      "--signing-key", key,
      "--minimum-desktop", "2.0.0",
      "--maximum-desktop", "1.0.0",
      "--output", join(directory, "invalid-range.json")
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(invalidRange.status, 0);
    assert.match(invalidRange.stderr, /must not exceed/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
