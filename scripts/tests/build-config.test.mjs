import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEFAULT_CONFIG,
  formatDisplayVersion,
  loadBuildConfig,
  normalizePublicRepository,
  resolveBuildValues,
  resolveDesktopRepository
} from "../lib/build-config.mjs";

const root = resolve(import.meta.dirname, "../..");

test("adds the display prefix only when it is missing", () => {
  assert.equal(formatDisplayVersion("1.0.0"), "v1.0.0");
  assert.equal(formatDisplayVersion("v1.0.0"), "v1.0.0");
});

test("uses built-in defaults without an env file", async () => {
  const config = await loadBuildConfig(root, { environment: {}, envFile: resolve(root, "target/missing.env") });
  assert.equal(config.productName, DEFAULT_CONFIG.DESKTOP_APP_NAME);
  assert.equal(config.version, DEFAULT_CONFIG.DESKTOP_APP_VERSION);
  assert.equal(config.displayVersion, `v${DEFAULT_CONFIG.DESKTOP_APP_VERSION}`);
  assert.equal(config.windowTitle, `${DEFAULT_CONFIG.DESKTOP_APP_NAME} v${DEFAULT_CONFIG.DESKTOP_APP_VERSION}`);
  assert.equal(config.repository, "https://github.com/deepseek-desktop/deepseek-desktop");
  assert.equal(config.harness.repository, DEFAULT_CONFIG.HARNESS_REPOSITORY);
  assert.equal(config.harness.ref, "");
  assert.deepEqual(config.harnessUpdate, {
    manifestUrl: "",
    channel: "stable",
    autoUpdate: false,
    publisher: "deepseek-desktop",
    publicKey: "",
    desktopProtocolVersion: 1,
    harnessProtocolVersion: 1,
    credentialProtocolVersion: 1
  });
  assert.deepEqual(config.release, { channel: "local", signed: false });
  assert.equal(config.toolchain.nodeVersion, "24.20.0");
  assert.equal(config.toolchain.rustVersion, "1.98.0");
});

test("environment values override env file values", () => {
  const values = resolveBuildValues({
    fileValues: { DESKTOP_APP_NAME: "File Name", HARNESS_REF: "file-ref" },
    environment: { DESKTOP_APP_NAME: "Environment Name" }
  });
  assert.equal(values.DESKTOP_APP_NAME, "Environment Name");
  assert.equal(values.HARNESS_REF, "file-ref");
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
    "HARNESS_REPOSITORY=git@github.com:example/deepseek-harness.git",
    "HARNESS_REF=release-candidate",
    "HARNESS_UPDATE_MANIFEST_URL=https://updates.example.com/harness/manifest.json",
    "HARNESS_UPDATE_CHANNEL=preview",
    "HARNESS_AUTO_UPDATE=true",
    "HARNESS_UPDATE_PUBLISHER=example-desktop",
    `HARNESS_UPDATE_PUBLIC_KEY=${Buffer.alloc(32, 7).toString("base64")}`,
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
    assert.equal(config.displayVersion, "v2.3.4-preview.5");
    assert.equal(config.windowTitle, "命令行桌面 v2.3.4-preview.5");
    assert.equal(config.identifier, "example.custom.desktop");
    assert.equal(config.slug, "custom-desktop");
    assert.deepEqual(config.authors, ["Alice", "Bob"]);
    assert.equal(config.repository, "https://git.example.com/team/desktop");
    assert.equal(config.harness.repository, "git@github.com:example/deepseek-harness.git");
    assert.equal(config.harness.ref, "release-candidate");
    assert.equal(config.harnessUpdate.manifestUrl, "https://updates.example.com/harness/manifest.json");
    assert.equal(config.harnessUpdate.channel, "preview");
    assert.equal(config.harnessUpdate.autoUpdate, false);
    assert.equal(config.harnessUpdate.publisher, "example-desktop");
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

test("uses Harness throughout the public shell contracts, copy, and package commands", async () => {
  for (const path of ["src/contracts.ts", "src/desktop.ts", "src/i18n/messages.ts", "src/app-config.ts"]) {
    assert.doesNotMatch(await readFile(join(root, path), "utf8"), /runtime/iu, path);
  }
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.ok(manifest.scripts["harness:sync"]);
  assert.ok(manifest.scripts["harness:smoke"]);
  assert.doesNotMatch(JSON.stringify(manifest.scripts), /runtime/iu);
  const tauri = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(tauri.bundle.macOS.hardenedRuntime, false);
  assert.equal(tauri.bundle.macOS.hardenedHarness, undefined);
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

test("validates Harness update configuration and disables automatic updates for a fixed ref", async () => {
  const publicKey = Buffer.alloc(32, 3).toString("base64");
  const config = await loadBuildConfig(root, {
    environment: {
      HARNESS_REF: "dsh-v1.0.0",
      HARNESS_UPDATE_MANIFEST_URL: "file:///tmp/harness-manifest.json",
      HARNESS_UPDATE_PUBLIC_KEY: publicKey,
      HARNESS_AUTO_UPDATE: "true"
    },
    envFile: resolve(root, "target/missing.env")
  });
  assert.equal(config.harnessUpdate.autoUpdate, false);
  await assert.rejects(loadBuildConfig(root, {
    environment: { HARNESS_UPDATE_CHANNEL: "nightly" },
    envFile: resolve(root, "target/missing.env")
  }), /stable or preview/u);
  await assert.rejects(loadBuildConfig(root, {
    environment: { HARNESS_AUTO_UPDATE: "yes" },
    envFile: resolve(root, "target/missing.env")
  }), /true or false/u);
  await assert.rejects(loadBuildConfig(root, {
    environment: { HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.com/harness.json" },
    envFile: resolve(root, "target/missing.env")
  }), /must be configured together/u);
  await assert.rejects(loadBuildConfig(root, {
    environment: { HARNESS_UPDATE_PUBLIC_KEY: publicKey },
    envFile: resolve(root, "target/missing.env")
  }), /must be configured together/u);
  await assert.rejects(loadBuildConfig(root, {
    environment: { HARNESS_UPDATE_PUBLISHER: "\n" },
    envFile: resolve(root, "target/missing.env")
  }), /must not be empty/u);
  await assert.rejects(loadBuildConfig(root, {
    environment: { HARNESS_UPDATE_PUBLIC_KEY: "not-a-key" },
    envFile: resolve(root, "target/missing.env")
  }), /32 Ed25519/u);
  await assert.rejects(loadBuildConfig(root, {
    environment: {
      HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.com/harness.json?token=secret",
      HARNESS_UPDATE_PUBLIC_KEY: publicKey
    },
    envFile: resolve(root, "target/missing.env")
  }), /query/u);
});

test("accepts empty Harness ref and Desktop repository for automatic resolution", () => {
  const values = resolveBuildValues({
    environment: { HARNESS_REF: " ", DESKTOP_APP_REPOSITORY: "" }
  });
  assert.equal(values.HARNESS_REF, "");
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

test("uses GitHub Actions repository metadata before a temporary clone origin", async () => {
  const config = await loadBuildConfig(root, {
    environment: {
      GITHUB_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://github.example.com/",
      GITHUB_REPOSITORY: "desktop/deepseek-desktop"
    },
    envFile: resolve(root, "target/missing.env")
  });
  assert.equal(config.repository, "https://github.example.com/desktop/deepseek-desktop");
});

test("ignores a local clone origin and falls back to the manifest repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-desktop-local-origin-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({
    repository: "git+https://github.com/example/desktop.git"
  }));
  const gitDirectory = join(directory, ".git");
  await mkdir(gitDirectory);
  await writeFile(join(gitDirectory, "config"), [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tbare = false",
    "[remote \"origin\"]",
    `\turl = ${join(directory, "source")}`
  ].join("\n"));
  try {
    assert.equal(
      await resolveDesktopRepository(directory, "", {}),
      "https://github.com/example/desktop"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    environment: { HARNESS_REPOSITORY: "https://token@example.com/deepseek-harness.git" },
    envFile: resolve(root, "target/missing.env")
  }), /must not contain embedded credentials/u);
  assert.throws(
    () => normalizePublicRepository("https://token@example.com/deepseek-desktop.git"),
    /must not contain embedded credentials/u
  );
});
