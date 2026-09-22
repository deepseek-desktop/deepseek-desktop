import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { artifactName, assertSemVer, compareSemVer, hostTarget, isPrereleaseSemVer, parseArguments, sha256, supportedTargets } from "../harness-update/common.mjs";

const root = resolve(import.meta.dirname, "../..");

test("signing key creation never overwrites an existing private key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-keygen-"));
  try {
    const path = join(directory, "signing.pem");
    const run = () => spawnSync(process.execPath, ["scripts/harness-update/keygen.mjs", path], { cwd: root, encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const original = await readFile(path);
    const second = run();
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /EEXIST/u);
    assert.deepEqual(await readFile(path), original);
    assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr, /BEGIN PRIVATE KEY/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps only native Harness update targets", () => {
  assert.equal(hostTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(hostTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => hostTarget("linux", "arm64"), /unsupported/u);
});

test("builds stable artifact names and validates SemVer", () => {
  assert.equal(
    artifactName("1.0.0", "x86_64-unknown-linux-gnu"),
    "deepseek-harness_1.0.0_x86_64-unknown-linux-gnu.tar.gz"
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
  const directory = await mkdtemp(join(tmpdir(), "deepseek-harness-manifest-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = join(directory, "signing.pem");
    await writeFile(key, privateKey.export({ format: "pem", type: "pkcs8" }));
    const desktopCommit = "a".repeat(40);
    const harnessCommit = "b".repeat(40);
    for (const target of Object.values(supportedTargets)) {
      const artifact = artifactName("1.0.0", target);
      const artifactPath = join(directory, artifact);
      await writeFile(artifactPath, `harness-${target}`);
      await writeFile(join(directory, `harness-update-descriptor.${target}.json`), JSON.stringify({
        schemaVersion: 1,
        harnessVersion: "1.0.0",
        harnessCommit,
        harnessRepository: "https://example.invalid/harness.git",
        harnessDirty: false,
        desktopCommit,
        desktopDirty: false,
        target,
        harnessProtocolVersion: 1,
        credentialProtocolVersion: 1,
        credentialProviderVersion: "1.0.0",
        nodeVersion: "24.20.0",
        nodeModuleAbi: "137",
        artifact: {
          file: artifact,
          size: Buffer.byteLength(`harness-${target}`),
          sha256: await sha256(artifactPath)
        }
      }));
    }
    const output = join(directory, "manifest.json");
    const result = spawnSync(process.execPath, [
      "scripts/harness-update/manifest.mjs",
      "--directory", directory,
      "--signing-key", key,
      "--base-url", "https://updates.example.com/harness/",
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
    assert.match(manifest.artifacts[Object.values(supportedTargets)[0]].url, /^https:\/\/updates\.example\.com\/harness\//u);

    const invalidRange = spawnSync(process.execPath, [
      "scripts/harness-update/manifest.mjs",
      "--directory", directory,
      "--signing-key", key,
      "--minimum-desktop", "2.0.0",
      "--maximum-desktop", "1.0.0",
      "--output", join(directory, "invalid-range.json")
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(invalidRange.status, 0);
    assert.match(invalidRange.stderr, /must not exceed/u);

    for (const version of ["1.1.0-alpha.2", "1.1.0-beta.1", "1.1.0-rc.1", "1.1.0-preview.1", "v1.1.0", "dsh-v1.1.0"]) {
      for (const target of Object.values(supportedTargets)) {
        const path = join(directory, `harness-update-descriptor.${target}.json`);
        const descriptor = JSON.parse(await readFile(path, "utf8"));
        descriptor.harnessVersion = version;
        await writeFile(path, JSON.stringify(descriptor));
      }
      for (const channel of ["stable", "preview"]) {
        const result = spawnSync(process.execPath, [
          "scripts/harness-update/manifest.mjs", "--directory", directory,
          "--signing-key", key, "--channel", channel, "--output", output
        ], { cwd: root, encoding: "utf8" });
        if (!version.startsWith("1.")) {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /Harness version must be valid SemVer/u);
        } else if (version.includes("alpha") || version.includes("beta")) {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /alpha and beta Harness versions are ignored/u);
        } else {
          assert.equal(result.status, 0, result.stderr);
          const signed = JSON.parse(await readFile(output, "utf8"));
          const payload = JSON.parse(Buffer.from(signed.signedPayload, "base64").toString("utf8"));
          assert.equal(payload.harnessVersion, version);
          assert.equal(payload.channel, channel);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repository preparation skips alpha and beta before dependency installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-version-filter-"));
  try {
    const source = join(directory, "source");
    const destination = join(directory, "candidate");
    const desktop = join(directory, "desktop");
    const resultFile = join(directory, "result.json");
    await mkdir(source);
    for (const version of ["1.0.0-alpha.2", "1.0.0-beta.1", "1.0.0-rc.1"]) {
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "test-cli", version, bin: { dsh: "dist/cli.js" } }));
      const result = spawnSync(process.execPath, [
        "scripts/harness-update/prepare-repository.mjs", source, destination, desktop, resultFile
      ], { cwd: root, encoding: "utf8" });
      const prepared = JSON.parse(await readFile(resultFile, "utf8"));
      if (version.includes("rc")) {
        // RC reaches the toolchain check; the fixture intentionally has no pnpm.
        assert.notEqual(result.status, 0);
        assert.match(prepared.error, /ENOENT/u);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(prepared, { version, entry: "" });
      }
      await assert.rejects(access(destination));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
