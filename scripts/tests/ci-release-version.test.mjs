import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { loadBuildConfig } from "../lib/build-config.mjs";

test("tagged CI pins the same Harness commit through the configuration entry point", async t => {
  const root = new URL("../../", import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "desktop-ci-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "environment");
  const result = spawnSync(process.execPath, ["scripts/ci-release-version.mjs"], {
    cwd: root,
    env: { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.0.0", GITHUB_ENV: envFile },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const environment = parseEnv(await readFile(envFile, "utf8"));
  const { harnessSource } = JSON.parse(await readFile(new URL("harness/toolchain-lock.json", root), "utf8"));
  const { fileURLToPath } = await import("node:url");
  const config = await loadBuildConfig(fileURLToPath(root), { environment: { ...environment, RELEASE_CHANNEL: "community" } });
  assert.equal(config.version, "1.0.0");
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
    env: { ...process.env, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.0.0", GITHUB_ENV: envFile },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const environment = parseEnv(await readFile(envFile, "utf8"));
  assert.equal(environment.HARNESS_REF, harnessSource.ref);
  assert.equal(environment.HARNESS_REPOSITORY, harnessSource.repository);
});
