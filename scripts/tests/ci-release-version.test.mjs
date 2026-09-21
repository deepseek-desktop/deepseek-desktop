import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { loadBuildConfig } from "../lib/build-config.mjs";
import { isPrereleaseVersion, parseDesktopVersion, parseReleaseTag, releaseTagsForVersion } from "../lib/release-tag.mjs";
import { releaseIsPrerelease } from "../ci-release-prerelease.mjs";

test("tagged CI pins the same Harness commit through the configuration entry point", async t => {
  const root = new URL("../../", import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "desktop-ci-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "environment");
  const result = spawnSync(process.execPath, ["scripts/ci-release-version.mjs"], {
    cwd: root,
    env: { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.6.1", GITHUB_ENV: envFile },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const environment = parseEnv(await readFile(envFile, "utf8"));
  const { harnessSource } = JSON.parse(await readFile(new URL("harness/toolchain-lock.json", root), "utf8"));
  const { fileURLToPath } = await import("node:url");
  const config = await loadBuildConfig(fileURLToPath(root), { environment: { ...environment, RELEASE_CHANNEL: "community" } });
  assert.equal(config.version, "0.1.6.1");
  assert.equal(config.harness.repository, harnessSource.repository);
  assert.equal(config.harness.ref, harnessSource.ref);
});

test("tagged CI preserves a locked Harness tag for release asset identity checks", async t => {
  const root = new URL("../../", import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "desktop-ci-tag-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts/lib"), { recursive: true });
  await mkdir(join(directory, "harness"));
  for (const file of ["scripts/ci-release-version.mjs", "scripts/lib/release-tag.mjs"]) {
    await copyFile(new URL(file, root), join(directory, file));
  }
  const { harnessSource } = JSON.parse(await readFile(new URL("harness/toolchain-lock.json", root), "utf8"));
  harnessSource.ref = "dsh-v0.1.5-rc.2";
  await writeFile(join(directory, "harness/toolchain-lock.json"), JSON.stringify({ harnessSource }));
  const envFile = join(directory, "environment");
  const result = spawnSync(process.execPath, ["scripts/ci-release-version.mjs"], {
    cwd: directory,
    env: { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.6.1", GITHUB_ENV: envFile },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const environment = parseEnv(await readFile(envFile, "utf8"));
  assert.equal(environment.HARNESS_REF, harnessSource.ref);
  assert.equal(environment.HARNESS_REPOSITORY, harnessSource.repository);
});


test("accepts release tags with or without a v prefix", () => {
  assert.deepEqual(parseReleaseTag("0.1.6.1"), { tag: "0.1.6.1", version: "0.1.6.1" });
  assert.deepEqual(parseReleaseTag("v0.1.6.1"), { tag: "v0.1.6.1", version: "0.1.6.1" });
});

test("derives the Harness core and internal bundle SemVer", () => {
  assert.deepEqual(parseDesktopVersion("0.1.6.27"), {
    version: "0.1.6.27",
    coreVersion: "0.1.6",
    revision: 27,
    bundleVersion: "0.1.6+27"
  });
});

test("rejects tags outside the four numeric segment contract", () => {
  for (const tag of ["", "release-0.1.6.1", "v0.1.6", "V0.1.6.1", "v00.1.6.1", "v0.1.6.0", "v0.1.6-rc.1"]) {
    assert.throws(() => parseReleaseTag(tag), /unsupported release tag/u);
  }
});

test("returns both accepted tag forms for a version", () => {
  assert.deepEqual(releaseTagsForVersion("0.1.6.1"), ["0.1.6.1", "v0.1.6.1"]);
});

test("four-part release versions have no prerelease syntax", () => {
  assert.equal(isPrereleaseVersion("0.1.6.1"), false);
  assert.throws(() => isPrereleaseVersion("0.1.6-rc.1"), /unsupported release version/u);
});


const signed = version => ({ version, release: { channel: "stable", signed: true } });
const community = version => ({ version, release: { channel: "community", signed: false } });

test("an unsigned build is a prerelease no matter how its version reads", () => {
  assert.equal(releaseIsPrerelease(community("1.0.16")), true);
  assert.equal(releaseIsPrerelease(community("2.0.0")), true);
  assert.equal(releaseIsPrerelease(community("1.0.0-rc.1")), true);
});

test("a signed four-part build can become a stable release", () => {
  assert.equal(releaseIsPrerelease(signed("0.1.6.1")), false);
  assert.throws(() => releaseIsPrerelease(signed("0.1.6-rc.1")), /unsupported release version/u);
});

test("a missing or non-boolean signature claim never promotes a release", () => {
  assert.equal(releaseIsPrerelease({ version: "1.0.16" }), true);
  assert.equal(releaseIsPrerelease({ version: "1.0.16", release: {} }), true);
  assert.equal(releaseIsPrerelease({ version: "1.0.16", release: { signed: "true" } }), true);
});

test("rejects configuration without a version", () => {
  assert.throws(() => releaseIsPrerelease({ release: { signed: true } }), /release version is missing/u);
});
