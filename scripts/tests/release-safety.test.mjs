import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertSourceRepository, detectHostTarget, loadTargets, redactError } from "../release-system/common.mjs";
import { contentCacheKey, createContentCacheManifest, makeContentTreeWritable, verifyContentCache } from "../release-system/content-cache.mjs";
import { artifactForbiddenRoots, scanArtifactPaths } from "../lib/artifact-scan.mjs";
import { portableRustFlags } from "../lib/rust-flags.mjs";
import { acquireToolchainLock } from "../lib/toolchain-lock.mjs";
import { createBuildSession, createStageReporter } from "../lib/build-session.mjs";

test("packaging shares one Harness build and stage across verification, E2E and smoke", async () => {
  const commands = [];
  const session = createBuildSession({
    runPnpm: args => commands.push(args.join(" ")),
    runNode: args => commands.push(args.join(" "))
  });
  await session.syncHarness();
  await session.verify();
  await session.e2e(["--project=webkit"]);
  await session.smoke();
  assert.equal(commands.filter(command => command === "harness:sync").length, 1);
  assert.equal(commands.filter(command => command === "harness:stage").length, 1);
  for (const required of ["test:config", "check:i18n", "test", "typecheck", "harness:test-locale", "harness:test-omlx", "harness:test-credentials", "harness:test-follow-model", "harness:verify", "rust:test", "rust:clippy", "node_modules/@playwright/test/cli.js test --project=webkit", "harness/scripts/smoke-harness.mjs --settings-ui"]) {
    assert.ok(commands.includes(required), `missing gate: ${required}`);
  }
  assert.ok(commands.indexOf("harness:sync") < commands.indexOf("harness:test-credentials"));
  assert.ok(commands.indexOf("harness:test-credentials") < commands.indexOf("harness:stage"));
  assert.ok(commands.indexOf("harness:stage") < commands.indexOf("harness:verify"));
});

test("standalone checks prepare their own Harness and a failed preparation cannot be reused", async () => {
  for (const check of ["verify", "e2e", "smoke"]) {
    const commands = [];
    const create = () => createBuildSession({
      runPnpm: args => commands.push(args[0]), runNode: args => commands.push(args[0])
    });
    await create()[check]();
    await create()[check]();
    assert.equal(commands.filter(command => command === "harness:sync").length, 2, check);
    const failed = createBuildSession({
      runPnpm: args => { if (args[0] === "harness:sync") throw new Error("preparation failed"); },
      runNode: () => assert.fail("must not execute tests against an incomplete Harness")
    });
    await assert.rejects(failed[check](), /preparation failed/u);
    await assert.rejects(failed.e2e(), /preparation failed/u);
  }
});

test("stage timing includes failures in Actions logs and summary", async t => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = join(directory, "summary.md");
  const timings = {};
  const logs = [];
  const stage = createStageReporter({ timings, env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary }, log: line => logs.push(line) });
  assert.equal(await stage("installMs", () => 42), 42);
  await assert.rejects(stage("harnessSyncMs", () => { throw new Error("failed to build"); }), /failed to build/u);
  assert.ok(timings.installMs >= 0 && timings.harnessSyncMs >= 0);
  assert.equal(logs.filter(line => line === "::endgroup::").length, 2);
  const report = await readFile(summary, "utf8");
  assert.match(report, /install \| passed/u);
  assert.match(report, /harnessSync \| failed/u);
  assert.equal(report.match(/### 构建阶段耗时/gu)?.length, 1);
});

test("Rust commands wait for the active toolchain writer and release the lock", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-rust-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireToolchainLock(root);
  await assert.rejects(acquireToolchainLock(root, 0), /waiting for the Rust toolchain lock/u);
  let acquired = false;
  const waiting = acquireToolchainLock(root).then(unlock => { acquired = true; return unlock; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(acquired, false);
  await release();
  await (await waiting)();
  await (await acquireToolchainLock(root, 0))();
});

const harnessCommit = "b".repeat(40);

async function symlinkOrSkip(t, target, path) {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("creating symbolic links requires Windows Developer Mode or elevated privileges");
      return false;
    }
    throw error;
  }
}

test("the standard build prepares Harness before Tauri compiles the frontend", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const tauriConfig = JSON.parse(await readFile(resolve("src-tauri/tauri.conf.json"), "utf8"));
  assert.match(packageJson.scripts.build, /tauri:build/u);
  const tauriBuild = packageJson.scripts["tauri:build"];
  const appSyncIndex = tauriBuild.indexOf("app-sync.mjs");
  const harnessSyncIndex = tauriBuild.indexOf("harness-sync.mjs");
  const harnessStageIndex = tauriBuild.indexOf("stage-harness.mjs");
  const tauriIndex = tauriBuild.indexOf("tauri build");
  assert.ok(appSyncIndex >= 0 && appSyncIndex < harnessSyncIndex);
  assert.ok(harnessSyncIndex < harnessStageIndex && harnessStageIndex < tauriIndex);
  assert.equal(tauriConfig.build.beforeBuildCommand, "node scripts/with-pnpm.mjs frontend:build");
  assert.doesNotMatch(packageJson.scripts["frontend:build"], /app:sync|app-sync|harness:sync|harness-sync/u);
  const playwrightConfig = await readFile(resolve("playwright.config.ts"), "utf8");
  assert.match(playwrightConfig, /\$\{pnpm\} frontend:build/u);
  assert.doesNotMatch(playwrightConfig, /\$\{pnpm\} build &&/u);
});

test("target configuration maps only supported native hosts", async () => {
  const { targets } = await loadTargets();
  assert.deepEqual(targets.map(target => target.id), ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"]);
  assert.equal((await detectHostTarget("darwin", "arm64")).triple, "aarch64-apple-darwin");
  assert.equal((await detectHostTarget("win32", "x64")).id, "windows-x64");
  await assert.rejects(() => detectHostTarget("darwin", "ia32"), /unsupported release worker host/u);
});

test("source repositories reject embedded HTTP credentials", () => {
  assert.equal(assertSourceRepository("ssh://git@git.example.com/team/desktop.git"), "ssh://git@git.example.com/team/desktop.git");
  assert.throws(() => assertSourceRepository("https://token@git.example.com/team/desktop.git"), /embedded HTTP credentials/u);
  assert.throws(() => assertSourceRepository("ssh://git:password@git.example.com/team/desktop.git"), /embedded password/u);
});

test("portable Rust flags remap the project, Cargo cache, and user home", () => {
  const projectRoot = resolve("/Users/developer/project");
  const cargoTargetDir = resolve("/Users/developer/cache/cargo");
  const userHome = resolve("/Users/developer");
  const flags = portableRustFlags({
    projectRoot,
    cargoTargetDir,
    userHome,
    existing: "-C debuginfo=1"
  });
  assert.ok(flags.includes(`--remap-path-prefix=${userHome}=/build/home`));
  assert.ok(flags.includes(`--remap-path-prefix=${projectRoot}=/build/source`));
  assert.ok(flags.includes(`--remap-path-prefix=${cargoTargetDir}=/build/cargo-target`));
});

test("release errors redact credentials and common user-home paths", () => {
  const message = redactError(new Error("sk-1234567890abcdefghijkl /Users/developer/private/file C:\\Users\\developer\\private\\file /home/developer/private/file"));
  assert.doesNotMatch(message, /sk-123|developer|private\/file/u);
  assert.match(message, /\[REDACTED\]/u);
  assert.equal(message.match(/\[LOCAL_PATH\]/gu)?.length, 3);
});

test("artifact scanner uses precise CI roots and the real local home", () => {
  const platformPath = value => resolve(value).replaceAll("\\", "/");
  const projectRoot = platformPath("/Users/runner/work/deepseek-desktop/deepseek-desktop");
  const runnerWorkspace = platformPath("/Users/runner/work/deepseek-desktop");
  const runnerTemp = platformPath("/Users/runner/work/_temp");
  assert.deepEqual(
    artifactForbiddenRoots(projectRoot, {
      CI: "true",
      HOME: platformPath("/Users/runner"),
      GITHUB_WORKSPACE: projectRoot,
      RUNNER_WORKSPACE: runnerWorkspace,
      RUNNER_TEMP: runnerTemp
    }, platformPath("/Users/runner")),
    [projectRoot, runnerWorkspace, runnerTemp]
  );
  const localRoot = platformPath("/workspace/deepseek-desktop");
  const localHome = platformPath("/Users/developer");
  assert.deepEqual(
    artifactForbiddenRoots(localRoot, { CI: "false", HOME: localHome }, localHome),
    [localRoot, localHome]
  );
});

test("artifact scanner rejects environment files, local paths, and secrets", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-artifact-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scanRoot = join(directory, "root");
  await mkdir(scanRoot);
  const clean = join(scanRoot, "clean.bin");
  await writeFile(clean, "portable artifact");
  assert.deepEqual(await scanArtifactPaths([clean], { forbiddenRoots: [directory] }), {
    schemaVersion: 1,
    scannerVersion: 3,
    fileCount: 1,
    byteCount: 17
  });
  const secret = join(scanRoot, "secret.bin");
  await writeFile(secret, "sk-1234567890abcdefghij1234567890");
  await assert.rejects(() => scanArtifactPaths([secret]), /API key/u);
  await writeFile(secret, "AKIAIOSFODNN7EXAMPLE");
  await scanArtifactPaths([secret]);
  await writeFile(secret, "AKIA1234567890ABCDEF");
  await assert.rejects(() => scanArtifactPaths([secret]), /AWS access key/u);
  await writeFile(secret, `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----\n`);
  await assert.rejects(() => scanArtifactPaths([secret]), /private key/u);
  await writeFile(secret, Buffer.from(`-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----\n`, "utf16le"));
  await assert.rejects(() => scanArtifactPaths([secret]), /private key/u);
  await writeFile(secret, Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 0, 2, 0, 3, 0, 4]),
    Buffer.from(`-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----\n`)
  ]));
  await scanArtifactPaths([secret]);
  await writeFile(secret, Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 0, 2, 0, 3, 0, 4]),
    Buffer.from("sk-1234567890abcdefghij1234567890")
  ]));
  await assert.rejects(() => scanArtifactPaths([secret]), /API key/u);
  await writeFile(secret, `${directory}/private`);
  await assert.rejects(
    () => scanArtifactPaths([secret], { forbiddenRoots: [directory] }),
    /local path/u
  );
  await writeFile(secret, `${directory}s is a public documentation route`);
  await scanArtifactPaths([secret], { forbiddenRoots: [directory] });
  const chunkBoundaryPrefix = "x".repeat(65_536 - directory.length);
  await writeFile(secret, `${chunkBoundaryPrefix}${directory}s remains a public documentation route`);
  await scanArtifactPaths([secret], { forbiddenRoots: [directory] });
  await writeFile(secret, `${chunkBoundaryPrefix}${directory}/private`);
  await assert.rejects(
    () => scanArtifactPaths([secret], { forbiddenRoots: [directory] }),
    /local path/u
  );
  await writeFile(secret, `root=${directory}\n`);
  await assert.rejects(
    () => scanArtifactPaths([secret], { forbiddenRoots: [directory] }),
    /local path/u
  );
  await writeFile(secret, Buffer.concat([
    Buffer.from([0]),
    Buffer.from(`${directory}/private`, "utf16le")
  ]));
  await assert.rejects(
    () => scanArtifactPaths([secret], { forbiddenRoots: [directory] }),
    /local path/u
  );
  const environment = join(scanRoot, ".env.production");
  await writeFile(environment, "KEY=value\n");
  await assert.rejects(() => scanArtifactPaths([environment]), /environment file/u);
  await rm(secret);
  await rm(environment);
  const internalLink = join(scanRoot, "internal-link");
  if (!await symlinkOrSkip(t, "clean.bin", internalLink)) return;
  assert.equal((await scanArtifactPaths([scanRoot])).fileCount, 1);
  const outside = join(directory, "outside.bin");
  await writeFile(outside, "outside root");
  const outsideLink = join(scanRoot, "outside-link");
  await symlink("../outside.bin", outsideLink);
  await assert.rejects(() => scanArtifactPaths([scanRoot]), /symbolic link escaping/u);
  await rm(outsideLink);
  const absoluteLink = join(scanRoot, "absolute-link");
  await symlink(clean, absoluteLink);
  await assert.rejects(() => scanArtifactPaths([scanRoot]), /absolute symbolic link/u);
});

test("GitHub workflow pins first-party actions to immutable commits", async () => {
  const workflow = await readFile(resolve(import.meta.dirname, "../../.github/workflows/community-build.yml"), "utf8");
  const windowsAcceptance = await readFile(resolve(import.meta.dirname, "../verify-windows-install.ps1"), "utf8");
  const actions = [...workflow.matchAll(/uses:\s+(actions\/[^@\s]+)@([^\s#]+)/gu)];
  assert.ok(actions.length > 0);
  for (const [, name, revision] of actions) {
    assert.match(revision, /^[a-f0-9]{40}$/u, `${name} must use a full commit SHA`);
  }
  assert.doesNotMatch(workflow, /NO_STRIP/u, "the workflow must leave Linux-only Tauri flags to the packaging boundary");
  assert.match(
    workflow,
    /^on:\n  push:\n    tags:\n      - "\*\.\*\.\*\.\*"\n      - "v\*\.\*\.\*\.\*"\n\npermissions:/mu,
    "the release workflow must only listen for four-part version tags"
  );
  assert.doesNotMatch(workflow, /pull_request|branches:|workflow_dispatch|desktop:package/u);
  assert.doesNotMatch(workflow, /if:\s+startsWith\(github\.ref, 'refs\/tags\/'\)/u);
  assert.match(workflow, /test "\$\{#assets\[@\]\}" -eq 6/u);
  assert.match(workflow, /node scripts\/prepare-ci-release-assets\.mjs/u);
  assert.match(workflow, /node scripts\/prepare-ci-release-notes\.mjs/u);
  assert.match(workflow, /--notes-file release-assets\/RELEASE-NOTES\.md/u);
  assert.match(workflow, /release\/\*\*\/SHA256SUMS/u);
  assert.match(workflow, /node scripts\/ci-release-prerelease\.mjs/u);
  assert.match(workflow, /release_flags\+=\(--prerelease --latest=false\)/u);
  assert.match(workflow, /verify-windows-install\.ps1/u);
  assert.match(workflow, /-ExpectedVersion \$env:DESKTOP_APP_VERSION/u);
  // The native Windows acceptance job runs the script; retain only the control boundaries here.
  const dismissNames = windowsAcceptance.match(/\$dismissNames = @\(([^)]*)\)/u)?.[1] ?? "";
  const messages = await readFile(resolve(import.meta.dirname, "../../src/i18n/messages.ts"), "utf8");
  const updateLater = [...messages.matchAll(/\blater: "([^"]+)"/gu)].map(([, label]) => label);
  assert.equal(updateLater.length, 3, "every locale must ship an update.later label");
  for (const label of updateLater) {
    // A published higher four-part release makes the update prompt cover the workbench, so
    // acceptance has to defer it; deferring only hides the prompt for this run.
    assert.ok(dismissNames.includes(`"${label}"`), `acceptance must dismiss the update prompt with ${label}`);
  }
  for (const forbidden of ["保存并继续", "Save and continue", "前往下载", "Open Download", "忽略此版本", "Ignore Version"]) {
    // Saving submits a credential, downloading opens a browser, ignoring persists into user state.
    assert.ok(!dismissNames.includes(forbidden), `acceptance must never press ${forbidden}`);
  }
  // The release list truncates titles, so the tag must be the whole title.
  assert.match(workflow, /--title "\$GITHUB_REF_NAME"/u);
  assert.doesNotMatch(workflow, /--title "\$product_name/u);
  assert.doesNotMatch(workflow, /DESKTOP_RELEASE_PRERELEASE/u);
});

test("content-addressed release cache rejects corruption, target drift, and links", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-content-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "harness"), { recursive: true });
  await writeFile(join(directory, "harness", "entry.js"), "harness\n");
  const identity = { target: "aarch64-apple-darwin", harnessCommit, nodeVersion: "24.20.0", nodeAbi: "137" };
  const manifest = await createContentCacheManifest(directory, identity);
  await writeFile(join(directory, "cache-manifest.json"), `${JSON.stringify(manifest)}\n`);
  assert.match(contentCacheKey(identity), /^[0-9a-f]{64}$/u);
  await verifyContentCache(directory, identity);
  await assert.rejects(() => verifyContentCache(directory, { ...identity, target: "x86_64-apple-darwin" }), /identity/u);
  await writeFile(join(directory, "harness", "entry.js"), "corrupted\n");
  await assert.rejects(() => verifyContentCache(directory, identity), /file manifest/u);
  await rm(join(directory, "harness", "entry.js"));
  if (!await symlinkOrSkip(t, "../cache-manifest.json", join(directory, "harness", "linked"))) return;
  await assert.rejects(() => createContentCacheManifest(directory, identity), /symbolic links/u);
});

test("content-addressed release cache authenticates Unix executable modes", {
  skip: process.platform === "win32"
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-content-cache-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launcher = join(directory, "harness", "bin", "landlock-run");
  await mkdir(join(directory, "harness", "bin"), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\nexit 0\n");
  await chmod(launcher, 0o755);
  const identity = { target: "x86_64-unknown-linux-gnu", harnessCommit, nodeVersion: "24.20.0", nodeAbi: "137" };
  const manifest = await createContentCacheManifest(directory, identity);
  assert.equal(manifest.files.find(entry => entry.path === "harness/bin/landlock-run")?.mode, 0o755);
  await writeFile(join(directory, "cache-manifest.json"), `${JSON.stringify(manifest)}\n`);
  await verifyContentCache(directory, identity);
  await chmod(launcher, 0o644);
  await assert.rejects(() => verifyContentCache(directory, identity), /file manifest|mode/u);
});

test("restored cache working trees make read-only Harness files writable", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-content-cache-writable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = join(directory, "harness");
  const file = join(harness, "hatch_build.py");
  await mkdir(harness, { recursive: true });
  await writeFile(file, "original\n");
  await chmod(file, 0o444);
  await makeContentTreeWritable(harness);
  assert.notEqual((await stat(file)).mode & 0o200, 0);
  await writeFile(file, "restaged\n");
  assert.equal(await readFile(file, "utf8"), "restaged\n");
  if (process.platform !== "win32") {
    const executable = join(harness, "landlock-run");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o555);
    const executableBits = (await stat(executable)).mode & 0o111;
    await makeContentTreeWritable(harness);
    assert.equal((await stat(executable)).mode & 0o111, executableBits);
  }
});

test("writable content trees reject symbolic links before changing permissions", async t => {
  if (process.platform === "win32") {
    t.skip("creating symbolic links requires elevated Windows privileges");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "deepseek-content-writable-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.txt");
  await writeFile(target, "target\n");
  await chmod(target, 0o444);
  const originalMode = (await stat(target)).mode & 0o777;
  await symlink("target.txt", join(directory, "link.txt"));
  await assert.rejects(makeContentTreeWritable(directory), /cannot contain symbolic links/u);
  assert.equal((await stat(target)).mode & 0o777, originalMode);
});
