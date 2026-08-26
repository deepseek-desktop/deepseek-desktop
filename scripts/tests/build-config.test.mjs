import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_CONFIG, loadBuildConfig, normalizePublicRepository, resolveBuildValues } from "../lib/build-config.mjs";

const root = resolve(import.meta.dirname, "../..");

test("uses built-in defaults without an env file", async () => {
  const config = await loadBuildConfig(root, { environment: {}, envFile: resolve(root, "target/missing.env") });
  assert.equal(config.productName, DEFAULT_CONFIG.DESKTOP_APP_NAME);
  assert.equal(config.version, DEFAULT_CONFIG.DESKTOP_APP_VERSION);
  assert.equal(config.repository, "https://github.com/deepseek-desktop/deepseek-desktop");
  assert.equal(config.harness.repository, DEFAULT_CONFIG.RUNTIME_REPOSITORY);
  assert.equal(config.harness.ref, "");
  assert.deepEqual(config.release, { channel: "local", signed: false });
  assert.equal(config.toolchain.nodeVersion, "24.16.0");
  assert.equal(config.toolchain.rustVersion, "1.98.0");
});

test("environment values override env file values", () => {
  const values = resolveBuildValues({
    fileValues: { DESKTOP_APP_NAME: "File Name", RUNTIME_REF: "file-ref" },
    environment: { DESKTOP_APP_NAME: "Environment Name" }
  });
  assert.equal(values.DESKTOP_APP_NAME, "Environment Name");
  assert.equal(values.RUNTIME_REF, "file-ref");
});

test("loads every declared value from an env file before applying environment overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-desktop-config-"));
  const envFile = join(directory, ".env");
  await writeFile(envFile, [
    "DESKTOP_APP_NAME=定制桌面",
    "DESKTOP_APP_VERSION=2.3.4-preview.5",
    "DESKTOP_APP_IDENTIFIER=example.custom.desktop",
    "DESKTOP_APP_SLUG=custom-desktop",
    "DESKTOP_APP_DESCRIPTION=Custom agent workspace",
    "DESKTOP_APP_AUTHORS=Alice, Bob",
    "DESKTOP_APP_REPOSITORY=https://git.example.com/team/desktop.git",
    "DESKTOP_APP_ICON=src-tauri/icons/icon.png",
    "RUNTIME_REPOSITORY=git@github.com:example/deepseek-harness.git",
    "RUNTIME_REF=release-candidate",
    "RELEASE_CHANNEL=community",
    "RELEASE_SIGNED=true"
  ].join("\n"));
  try {
    const config = await loadBuildConfig(root, {
      environment: { DESKTOP_APP_NAME: "命令行桌面" },
      envFile
    });
    assert.equal(config.productName, "命令行桌面");
    assert.equal(config.version, "2.3.4-preview.5");
    assert.equal(config.identifier, "example.custom.desktop");
    assert.equal(config.slug, "custom-desktop");
    assert.deepEqual(config.authors, ["Alice", "Bob"]);
    assert.equal(config.repository, "https://git.example.com/team/desktop");
    assert.equal(config.harness.repository, "git@github.com:example/deepseek-harness.git");
    assert.equal(config.harness.ref, "release-candidate");
    assert.deepEqual(config.release, { channel: "community", signed: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unknown and required empty declared values", () => {
  assert.throws(() => resolveBuildValues({ fileValues: { DESKTOP_APP_NANE: "typo" } }), /unsupported build configuration/u);
  assert.throws(() => resolveBuildValues({ environment: { DESKTOP_APP_NAME: " " } }), /must not be empty/u);
  assert.throws(() => resolveBuildValues({ environment: { RELEASE_CHANEL: "stable" } }), /unsupported build configuration/u);
});

test("validates explicit release metadata", async () => {
  await assert.rejects(loadBuildConfig(root, {
    environment: { RELEASE_CHANNEL: "preview" },
    envFile: resolve(root, "target/missing.env")
  }), /local, community, or stable/u);
  await assert.rejects(loadBuildConfig(root, {
    environment: { RELEASE_SIGNED: "yes" },
    envFile: resolve(root, "target/missing.env")
  }), /true or false/u);
});

test("accepts empty Harness ref and Desktop repository for automatic resolution", () => {
  const values = resolveBuildValues({
    environment: { RUNTIME_REF: " ", DESKTOP_APP_REPOSITORY: "" }
  });
  assert.equal(values.RUNTIME_REF, "");
  assert.equal(values.DESKTOP_APP_REPOSITORY, "");
});

test("normalizes common Git remotes into browser repository URLs", () => {
  assert.equal(
    normalizePublicRepository("git@github.com:deepseek-desktop/deepseek-desktop.git"),
    "https://github.com/deepseek-desktop/deepseek-desktop"
  );
  assert.equal(
    normalizePublicRepository("git+https://github.com/deepseek-desktop/deepseek-desktop.git"),
    "https://github.com/deepseek-desktop/deepseek-desktop"
  );
  assert.equal(
    normalizePublicRepository("ssh://git@github.com/deepseek-desktop/deepseek-desktop.git"),
    "https://github.com/deepseek-desktop/deepseek-desktop"
  );
});

test("validates SemVer, identifier, slug, and icon paths", async () => {
  const cases = [
    ["DESKTOP_APP_VERSION", "1.0", /valid SemVer/u],
    ["DESKTOP_APP_IDENTIFIER", "desktop", /reverse-domain/u],
    ["DESKTOP_APP_SLUG", "Desktop App", /lowercase/u],
    ["DESKTOP_APP_ICON", "/tmp/icon.png", /relative/u],
    ["DESKTOP_APP_ICON", "C:\\icons\\icon.png", /relative/u]
  ];
  for (const [key, value, expected] of cases) {
    await assert.rejects(loadBuildConfig(root, { environment: { [key]: value }, envFile: resolve(root, "target/missing.env") }), expected);
  }
});

test("accepts spaces, Chinese text, and Windows separators in relative paths", async () => {
  const config = await loadBuildConfig(root, {
    environment: {
      DESKTOP_APP_NAME: "桌面 Workspace",
      DESKTOP_APP_ICON: "src-tauri\\icons\\icon.png"
    },
    envFile: resolve(root, "target/missing.env")
  });
  assert.equal(config.productName, "桌面 Workspace");
  assert.equal(config.iconSource, "src-tauri/icons/icon.png");
});

test("rejects repository URLs containing embedded credentials", async () => {
  await assert.rejects(loadBuildConfig(root, {
    environment: { RUNTIME_REPOSITORY: "https://token@example.com/deepseek-harness.git" },
    envFile: resolve(root, "target/missing.env")
  }), /must not contain embedded credentials/u);
  assert.throws(
    () => normalizePublicRepository("https://token@example.com/deepseek-desktop.git"),
    /must not contain embedded credentials/u
  );
});
