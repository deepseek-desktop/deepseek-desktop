import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { prepareCiReleaseAssets } from "../prepare-ci-release-assets.mjs";

const version = "1.0.0";
const commit = "0123456789abcdef0123456789abcdef01234567";
const toolchainLock = {
  node: { version: "24.20.0", moduleAbi: "137" },
  toolchain: { rust: "1.98.0", pnpm: "11.7.0", tauriCli: "2.11.4" }
};
const targets = new Map([
  ["aarch64-apple-darwin", ["DeepSeek Desktop_1.0.0_aarch64.dmg"]],
  ["x86_64-apple-darwin", ["DeepSeek Desktop_1.0.0_x64.dmg"]],
  ["x86_64-pc-windows-msvc", ["DeepSeek Desktop_1.0.0_x64-setup.exe"]],
  ["x86_64-unknown-linux-gnu", ["DeepSeek Desktop_1.0.0_amd64.AppImage", "DeepSeek Desktop_1.0.0_amd64.deb"]]
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(root, mutate = value => value) {
  for (const [target, installerNames] of targets) {
    const directory = join(root, "release", version, target);
    await mkdir(directory, { recursive: true });
    const buildInfoName = `BUILD-INFO.${target}.json`;
    const buildInfo = mutate({
      schemaVersion: 1,
      application: { productName: "DeepSeek Desktop", version },
      desktop: { commit, dirty: false },
      toolchain: {
        nodeVersion: toolchainLock.node.version,
        nodeModuleAbi: toolchainLock.node.moduleAbi,
        rustVersion: toolchainLock.toolchain.rust,
        pnpmVersion: toolchainLock.toolchain.pnpm,
        tauriCliVersion: toolchainLock.toolchain.tauriCli
      },
      harness: { repository: "https://example.invalid/runtime.git", commit: "runtime-commit", sha256: "runtime-hash" },
      target,
      channel: "community",
      signed: false,
      artifactAudit: { schemaVersion: 1, scannerVersion: 2, fileCount: 1, byteCount: 1 }
    }, target);
    const buildInfoText = `${JSON.stringify(buildInfo)}\n`;
    await writeFile(join(directory, buildInfoName), buildInfoText);
    const lines = [`${hash(buildInfoText)}  ${buildInfoName}`];
    for (const installerName of installerNames) {
      const content = `installer-${target}-${installerName}`;
      await writeFile(join(directory, installerName), content);
      lines.push(`${hash(content)}  ${installerName}`);
    }
    await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
  }
}

test("prepares exactly five public installers and one aggregate checksum file", async t => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-ci-release-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const output = join(root, "publish");
  const result = await prepareCiReleaseAssets({ inputRoot: root, outputRoot: output, version, commit, toolchainLock });
  assert.equal(result.installers.length, 5);
  const names = (await readdir(output)).sort();
  assert.equal(names.length, 6);
  assert.ok(names.includes("SHA256SUMS"));
  assert.ok(names.every(name => name === "SHA256SUMS" || !name.includes(" ")));
  assert.doesNotMatch(await readFile(result.checksums, "utf8"), /BUILD-INFO/u);
});

test("accepts platform-specific Runtime closure digests", async t => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-ci-release-closure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root, (buildInfo, target) => ({
    ...buildInfo,
    harness: { ...buildInfo.harness, sha256: `closure-${target}` }
  }));
  const result = await prepareCiReleaseAssets({
    inputRoot: root,
    outputRoot: join(root, "publish"),
    version,
    commit,
    toolchainLock
  });
  assert.equal(result.installers.length, 5);
});

test("rejects a target built from another Runtime commit", async t => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-ci-release-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root, (buildInfo, target) => target === "x86_64-apple-darwin"
    ? { ...buildInfo, harness: { ...buildInfo.harness, commit: "another-runtime-commit" } }
    : buildInfo);
  await assert.rejects(
    prepareCiReleaseAssets({ inputRoot: root, outputRoot: join(root, "publish"), version, commit, toolchainLock }),
    /release identity mismatch for x86_64-apple-darwin: harness\.commit/u
  );
});

test("rejects a target built with another toolchain identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-ci-release-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root, (buildInfo, target) => target === "x86_64-unknown-linux-gnu"
    ? { ...buildInfo, application: { ...buildInfo.application, productName: "Other Desktop" } }
    : buildInfo);
  await assert.rejects(
    prepareCiReleaseAssets({ inputRoot: root, outputRoot: join(root, "publish"), version, commit, toolchainLock }),
    /release identity mismatch for x86_64-unknown-linux-gnu: application\.productName/u
  );
});

test("rejects a target built from another Desktop commit", async t => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-ci-release-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root, (buildInfo, target) => target === "x86_64-pc-windows-msvc"
    ? { ...buildInfo, desktop: { commit: "different", dirty: false } }
    : buildInfo);
  await assert.rejects(
    prepareCiReleaseAssets({ inputRoot: root, outputRoot: join(root, "publish"), version, commit, toolchainLock }),
    /source mismatch/u
  );
});
