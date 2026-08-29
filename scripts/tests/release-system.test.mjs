import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { assertSourceRepository, detectHostTarget, loadTargets, parseArguments, redactError, sha256File } from "../release-system/common.mjs";
import { ReleaseControllerService } from "../release-system/controller-service.mjs";
import { requestJson, uploadArtifact } from "../release-system/http-client.mjs";
import { startReleaseServer } from "../release-system/http-server.mjs";
import { ReleaseStateStore } from "../release-system/state-store.mjs";
import { dockerImageContract, loadLocalAllConfig, macPathToParallelsShared, runWithConcurrency, windowsNodeToolchain } from "../release-system/local-all.mjs";
import {
  contentCacheKey,
  createContentCacheManifest,
  verifyContentCache
} from "../release-system/content-cache.mjs";
import { prepareRelease, preparedPlanIdentity, restorePreparedRelease } from "../release-system/prepared-release.mjs";
import { artifactForbiddenRoots, scanArtifactPaths } from "../lib/artifact-scan.mjs";
import { portableRustFlags } from "../lib/rust-flags.mjs";
import { cloneLockedSource, createLockedSourceBundle, resolveBundledTag } from "../release-system/git-source.mjs";

const desktopCommit = "a".repeat(40);
const runtimeCommit = "b".repeat(40);
const sourceRepository = "https://example.invalid/deepseek-desktop.git";
const runtimeRepository = "https://example.invalid/deepseek-harness.git";
const releaseToolchain = Object.freeze({
  nodeVersion: "24.20.0",
  nodeModuleAbi: "137",
  rustVersion: "1.98.0",
  pnpmVersion: "11.7.0",
  tauriCliVersion: "2.11.4"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(directory, args) {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

test("Linux release image contract changes with its build inputs", () => {
  const baseline = dockerImageContract({
    dockerfileSha256: "a".repeat(64),
    nodeVersion: "24.20.0",
    nodeModuleAbi: "137",
    targetArch: "x64"
  });
  assert.equal(baseline, dockerImageContract({
    dockerfileSha256: "a".repeat(64),
    nodeVersion: "24.20.0",
    nodeModuleAbi: "137",
    targetArch: "x64"
  }));
  assert.notEqual(baseline, dockerImageContract({
    dockerfileSha256: "b".repeat(64),
    nodeVersion: "24.20.0",
    nodeModuleAbi: "137",
    targetArch: "x64"
  }));
});

test("Tauri build performs frontend compilation without rewriting prepared app config", async () => {
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const tauriConfig = JSON.parse(await readFile(resolve("src-tauri/tauri.conf.json"), "utf8"));
  assert.match(packageJson.scripts.build, /app-sync\.mjs/u);
  assert.match(packageJson.scripts.build, /frontend:build/u);
  assert.equal(tauriConfig.build.beforeBuildCommand, "node scripts/with-pnpm.mjs frontend:build");
  assert.doesNotMatch(packageJson.scripts["frontend:build"], /app:sync|app-sync/u);
});

function releaseInput({ channel = "local", targetId = "macos-arm64", trustedNodeId = "" } = {}) {
  return {
    productName: "DeepSeek Desktop",
    version: "1.0.0",
    tag: "v1.0.0",
    channel,
    signed: false,
    source: { repository: sourceRepository, tag: "v1.0.0", commit: desktopCommit },
    runtime: { repository: runtimeRepository, ref: "v1.0.0", commit: runtimeCommit },
    toolchain: releaseToolchain,
    targets: [{ id: targetId, trustedNodeId }]
  };
}

async function createService(root, overrides = {}) {
  const store = new ReleaseStateStore(root);
  await store.initialize();
  const service = new ReleaseControllerService({
    store,
    verifyRemoteTag: async () => desktopCommit,
    ...overrides
  });
  return { store, service };
}

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
  const flags = portableRustFlags({
    projectRoot: "/Users/developer/project",
    cargoTargetDir: "/Users/developer/cache/cargo",
    userHome: "/Users/developer",
    existing: "-C debuginfo=1"
  });
  assert.match(flags, /--remap-path-prefix=\/Users\/developer=\/build\/home/u);
  assert.match(flags, /--remap-path-prefix=\/Users\/developer\/project=\/build\/source/u);
  assert.match(flags, /--remap-path-prefix=\/Users\/developer\/cache\/cargo=\/build\/cargo-target/u);
});

test("workers can clone a locked local bundle while preserving the canonical repository identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-source-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const checkout = join(directory, "checkout");
  const bundle = join(directory, "source.bundle");
  await mkdir(source);
  git(source, ["init"]);
  git(source, ["config", "user.name", "Release Test"]);
  git(source, ["config", "user.email", "release-test@example.invalid"]);
  await writeFile(join(source, "README.md"), "locked source\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "-m", "test source"]);
  git(source, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);
  const commit = git(source, ["rev-parse", "HEAD"]);
  await createLockedSourceBundle({ repositoryRoot: source, tag: "v1.0.0", commit, destination: bundle });
  assert.equal(await resolveBundledTag(bundle, "v1.0.0"), commit);
  await assert.rejects(() => resolveBundledTag(bundle, "v1.0.1"), /does not contain release tag/u);
  await cloneLockedSource({
    repository: "ssh://git@example.invalid/team/deepseek-desktop.git",
    sourceBundle: bundle,
    tag: "v1.0.0",
    commit,
    destination: checkout
  });
  assert.equal(git(checkout, ["rev-parse", "HEAD"]), commit);
  assert.equal(git(checkout, ["status", "--porcelain"]), "");
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
    scannerVersion: 2,
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
  await symlink("clean.bin", internalLink);
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
  const actions = [...workflow.matchAll(/uses:\s+(actions\/[^@\s]+)@([^\s#]+)/gu)];
  assert.ok(actions.length > 0);
  for (const [, name, revision] of actions) {
    assert.match(revision, /^[a-f0-9]{40}$/u, `${name} must use a full commit SHA`);
  }
  const noStripAssignments = [...workflow.matchAll(/NO_STRIP:\s+"1"/gu)];
  const linuxPackageSteps = [...workflow.matchAll(/if: runner\.os == 'Linux'[^\n]*\n\s+run:[^\n]*\n\s+env:\n\s+NO_STRIP:\s+"1"/gu)];
  assert.equal(noStripAssignments.length, 2, "NO_STRIP must only be assigned by Linux package steps");
  assert.equal(linuxPackageSteps.length, 2, "both Linux package paths must disable stripping");
});

test("release argument parser ignores the package-manager separator", () => {
  const parsed = parseArguments(["--", "--check", "--target", "linux-x64"]);
  assert.equal(parsed.options.has(""), false);
  assert.deepEqual(parsed.options.get("check"), ["true"]);
  assert.deepEqual(parsed.options.get("target"), ["linux-x64"]);
});

test("single-host release config is strict and maps macOS paths into Parallels shares", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-local-all-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const validPath = join(directory, "valid.json");
  await writeFile(validPath, `${JSON.stringify({
    schemaVersion: 1,
    docker: { image: "local/deepseek-builder:1.0.0", rebuild: true },
    windows: { vm: "Windows 11", controllerHost: "10.211.55.2" },
    destination: "release/local-all"
  })}\n`);
  const config = await loadLocalAllConfig(validPath, { explicit: true });
  assert.equal(config.docker.image, "local/deepseek-builder:1.0.0");
  assert.equal(config.windows.adapter, "parallels");
  assert.equal(config.windows.workRoot, "C:\\DeepSeekDesktopRelease");
  assert.equal(
    macPathToParallelsShared("/Users/developer/project/worker.mjs", { hostHome: "/Users/developer", guestHome: "\\\\Mac\\Home" }),
    "\\\\Mac\\Home\\project\\worker.mjs"
  );

  const unknownPath = join(directory, "unknown.json");
  await writeFile(unknownPath, `${JSON.stringify({ schemaVersion: 1, target: "windows-x64" })}\n`);
  await assert.rejects(() => loadLocalAllConfig(unknownPath, { explicit: true }), /unknown keys: target/u);
  const unsafeHostPath = join(directory, "unsafe-host.json");
  await writeFile(unsafeHostPath, `${JSON.stringify({ schemaVersion: 1, windows: { controllerHost: "host\nname" } })}\n`);
  await assert.rejects(() => loadLocalAllConfig(unsafeHostPath, { explicit: true }), /single line/u);
  assert.throws(
    () => macPathToParallelsShared("/private/tmp/worker.mjs", { hostHome: "/Users/developer", guestHome: "\\\\Mac\\Home" }),
    /must be under/u
  );
});

test("Windows local worker uses the exact Node toolchain declared by the lock", () => {
  const configuration = windowsNodeToolchain({
    node: {
      version: "24.20.0",
      moduleAbi: "137",
      artifacts: {
        "x86_64-pc-windows-msvc": {
          archive: "node-v24.20.0-win-x64.zip",
          sha256: "c".repeat(64)
        }
      }
    }
  }, "C:\\DeepSeekDesktopRelease\\toolchain", "\\\\Mac\\Home\\node.zip");
  assert.equal(configuration.version, "24.20.0");
  assert.equal(configuration.expectedModuleAbi, "137");
  assert.equal(configuration.expectedSha256, "c".repeat(64));
  assert.equal(configuration.node, "C:\\DeepSeekDesktopRelease\\toolchain\\node\\node-v24.20.0-win-x64\\node.exe");
  assert.equal(configuration.marker, "C:\\DeepSeekDesktopRelease\\toolchain\\node\\node-v24.20.0-win-x64\\.archive-sha256");
  assert.throws(() => windowsNodeToolchain({ node: { version: "24.20.0", artifacts: {} } }, "C:\\work", "node.zip"), /has no Node artifact/u);
});

test("release preparation signs immutable inputs, reuses valid cache, and rejects drift", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-release-prepare-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "runtime"), { recursive: true });
  await mkdir(join(directory, "target", "generated", "branding"), { recursive: true });
  await mkdir(join(directory, "target", "generated", "runtime", "prepared"), { recursive: true });
  await writeFile(join(directory, ".gitignore"), "target/\n");
  await writeFile(join(directory, "source.txt"), "trusted source\n");
  await writeFile(join(directory, "runtime", "toolchain-lock.json"), `${JSON.stringify({
    node: { version: process.versions.node, moduleAbi: process.versions.modules },
    runtimeSource: { repository: runtimeRepository, ref: "v1.0.0", commit: runtimeCommit },
    toolchain: { rust: "1.98.0", pnpm: "11.7.0" }
  })}\n`);
  await writeFile(join(directory, "target", "generated", "app-config.json"), "{}\n");
  await writeFile(join(directory, "target", "generated", "tauri.conf.json"), "{}\n");
  await writeFile(join(directory, "target", "generated", "branding", "icon.txt"), "icon\n");
  await writeFile(join(directory, "target", "generated", "runtime-source.json"), `${JSON.stringify({ resolvedCommit: runtimeCommit })}\n`);
  await writeFile(join(directory, "target", "generated", "runtime-lock.json"), `${JSON.stringify({ runtime: { commit: runtimeCommit, sha256: sha256("runtime") } })}\n`);
  await writeFile(join(directory, "target", "generated", "runtime", "prepared", "entry.js"), "export {};\n");
  git(directory, ["init"]);
  git(directory, ["config", "user.email", "tests@example.invalid"]);
  git(directory, ["config", "user.name", "Release Tests"]);
  git(directory, ["add", ".gitignore", "source.txt", "runtime/toolchain-lock.json"]);
  git(directory, ["commit", "-m", "fixture"]);
  git(directory, ["tag", "v1.0.0"]);
  const cacheRoot = join(directory, "target", "prepared-cache");
  const first = await prepareRelease({ root: directory, tag: "v1.0.0", cacheRoot, runChecks: false });
  assert.equal(first.cacheHit, false);
  await rm(join(directory, "target", "generated"), { recursive: true, force: true });
  const second = await prepareRelease({ root: directory, tag: "v1.0.0", cacheRoot, runChecks: false });
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.descriptor, first.descriptor);
  assert.equal(await readFile(join(directory, "target", "generated", "app-config.json"), "utf8"), "{}\n");
  const plan = {
    tag: "v1.0.0",
    version: "1.0.0",
    channel: "community",
    signed: false,
    source: { commit: git(directory, ["rev-parse", "HEAD"]) },
    runtime: { commit: runtimeCommit },
    tasks: ["linux-x64", "macos-arm64", "macos-x64", "windows-x64"].map(targetId => ({ targetId }))
  };
  assert.deepEqual(preparedPlanIdentity(plan).targetIds, ["linux-x64", "macos-arm64", "macos-x64", "windows-x64"]);
  await restorePreparedRelease({ root: directory, preparedRoot: cacheRoot, expectedDescriptor: first.descriptor, plan });
  const receipt = await readFile(first.receiptPath, "utf8");
  assert.equal(receipt.includes(directory), false, "prepared receipt must not contain a local path");
  await writeFile(join(first.directory, "payload", "app-config.json"), "corrupted\n");
  const rebuilt = await prepareRelease({ root: directory, tag: "v1.0.0", cacheRoot, runChecks: false });
  assert.equal(rebuilt.cacheHit, false);
  await writeFile(join(directory, "source.txt"), "drifted source\n");
  await assert.rejects(() => prepareRelease({ root: directory, tag: "v1.0.0", cacheRoot, runChecks: false }), /clean Desktop worktree/u);
});

test("content-addressed release cache rejects corruption, target drift, and links", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-content-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "runtime"), { recursive: true });
  await writeFile(join(directory, "runtime", "entry.js"), "runtime\n");
  const identity = { target: "aarch64-apple-darwin", runtimeCommit, nodeVersion: "24.20.0", nodeAbi: "137" };
  const manifest = await createContentCacheManifest(directory, identity);
  await writeFile(join(directory, "cache-manifest.json"), `${JSON.stringify(manifest)}\n`);
  assert.match(contentCacheKey(identity), /^[0-9a-f]{64}$/u);
  await verifyContentCache(directory, identity);
  await assert.rejects(() => verifyContentCache(directory, { ...identity, target: "x86_64-apple-darwin" }), /identity/u);
  await writeFile(join(directory, "runtime", "entry.js"), "corrupted\n");
  await assert.rejects(() => verifyContentCache(directory, identity), /file manifest/u);
  await rm(join(directory, "runtime", "entry.js"));
  await symlink("../cache-manifest.json", join(directory, "runtime", "linked"));
  await assert.rejects(() => createContentCacheManifest(directory, identity), /symbolic links/u);
});

test("local release scheduler respects concurrency and preserves failed results", async () => {
  let active = 0;
  let maximum = 0;
  const tasks = Array.from({ length: 5 }, (_, index) => async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    active -= 1;
    if (index === 3) throw new Error("expected worker failure");
    return index;
  });
  const results = await runWithConcurrency(tasks, 2);
  assert.equal(maximum, 2);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled"]);
  assert.deepEqual(results.filter(result => result.status === "fulfilled").map(result => result.value), [0, 1, 2, 4]);
});

test("official tasks require a trusted node and reject ticket misuse", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-release-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = await createService(directory);
  await assert.rejects(() => service.createRelease(releaseInput({ channel: "community" })), /trusted node id/u);
  const created = await service.createRelease(releaseInput({ channel: "community", trustedNodeId: "trusted.mac.arm64" }));
  await assert.rejects(() => service.claimTask({
    ticket: created.tickets["macos-arm64"],
    targetId: "macos-x64",
    nodeId: "trusted.mac.arm64"
  }), /bound to macos-arm64/u);
  await assert.rejects(() => service.claimTask({
    ticket: created.tickets["macos-arm64"],
    targetId: "macos-arm64",
    nodeId: "untrusted.mac.arm64"
  }), /bound to trusted node/u);
  const claimed = await service.claimTask({
    ticket: created.tickets["macos-arm64"],
    targetId: "macos-arm64",
    nodeId: "trusted.mac.arm64"
  });
  assert.equal(claimed.plan.source.commit, desktopCommit);
  assert.equal(claimed.plan.runtime.commit, runtimeCommit);
  await assert.rejects(() => service.claimTask({
    ticket: created.tickets["macos-arm64"],
    targetId: "macos-arm64",
    nodeId: "trusted.mac.arm64"
  }), /invalid or unknown worker ticket|already been used/u);
});

test("distributed release HTTP smoke streams, validates, and publishes artifacts", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-release-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { service } = await createService(join(directory, "controller"));
  const adminToken = "admin-token-for-http-smoke";
  const server = await startReleaseServer({ service, host: "127.0.0.1", port: 0, adminToken });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const controller = `http://127.0.0.1:${address.port}`;

  const created = await requestJson(controller, "/v1/releases", {
    method: "POST",
    token: adminToken,
    body: releaseInput()
  });
  const releaseId = created.release.id;
  const claimed = await requestJson(controller, "/v1/worker/claim", {
    method: "POST",
    body: {
      ticket: created.tickets["macos-arm64"],
      targetId: "macos-arm64",
      nodeId: "local.mac.arm64",
      host: { platform: "darwin", architecture: "arm64", hostname: "local-mac" }
    }
  });
  await requestJson(controller, `/v1/tasks/${claimed.taskId}/status`, {
    method: "POST",
    token: claimed.lease,
    body: { status: "building" }
  });

  const artifacts = join(directory, "worker-artifacts");
  await mkdir(artifacts, { recursive: true });
  const installerName = "DeepSeek.Desktop_1.0.0_aarch64.dmg";
  const buildInfoName = "BUILD-INFO.aarch64-apple-darwin.json";
  const installer = Buffer.from("fixture installer bytes", "utf8");
  const buildInfo = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    application: { version: "1.0.0" },
    desktop: { commit: desktopCommit, dirty: false },
    harness: { repository: runtimeRepository, commit: runtimeCommit },
    toolchain: releaseToolchain,
    target: "aarch64-apple-darwin",
    channel: "local",
    signed: false,
    artifactAudit: { schemaVersion: 1, scannerVersion: 2, fileCount: 3, byteCount: 1024 }
  }, null, 2)}\n`, "utf8");
  const checksum = Buffer.from(`${sha256(installer)}  ${installerName}\n${sha256(buildInfo)}  ${buildInfoName}\n`, "utf8");
  const fixtureFiles = new Map([
    [installerName, installer],
    [buildInfoName, buildInfo],
    ["SHA256SUMS", checksum]
  ]);
  for (const [name, bytes] of fixtureFiles) {
    const path = join(artifacts, name);
    await writeFile(path, bytes);
    await uploadArtifact(controller, claimed.taskId, claimed.lease, path, name, await sha256File(path));
  }
  const completed = await requestJson(controller, `/v1/tasks/${claimed.taskId}/complete`, {
    method: "POST",
    token: claimed.lease,
    body: {}
  });
  assert.equal(completed.release.status, "ready");

  const destination = join(directory, "published");
  const published = await requestJson(controller, `/v1/releases/${releaseId}/publish`, {
    method: "POST",
    token: adminToken,
    body: { provider: "filesystem", destination }
  });
  assert.equal(published.provider, "filesystem");
  const publishedEntries = (await readdir(join(destination, "v1.0.0"))).sort();
  assert.deepEqual(publishedEntries, [installerName, "SHA256SUMS"].sort());
  const globalChecksums = await readFile(join(destination, "v1.0.0", "SHA256SUMS"), "utf8");
  assert.match(globalChecksums, new RegExp(`${sha256(installer)}  ${installerName.replaceAll(".", "\\.")}`, "u"));
  assert.doesNotMatch(globalChecksums, /BUILD-INFO/u);
});

test("release HTTP client bounds response size and total request time", async t => {
  const oversized = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: "x".repeat(2048) }));
  });
  await new Promise(resolve => oversized.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => oversized.close(resolve)));
  const oversizedAddress = oversized.address();
  await assert.rejects(
    () => requestJson(`http://127.0.0.1:${oversizedAddress.port}`, "/", { responseLimit: 128 }),
    /exceeds 128 bytes/u
  );

  const stalled = createServer(() => {});
  await new Promise(resolve => stalled.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => stalled.close(resolve)));
  const stalledAddress = stalled.address();
  await assert.rejects(
    () => requestJson(`http://127.0.0.1:${stalledAddress.port}`, "/", { timeoutMs: 50 }),
    /timed out/u
  );
});

test("completion rejects source facts and local path leakage", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-release-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, service } = await createService(directory);
  const created = await service.createRelease(releaseInput());
  const claimed = await service.claimTask({
    ticket: created.tickets["macos-arm64"],
    targetId: "macos-arm64",
    nodeId: "local.mac.arm64"
  });
  const incoming = join(store.root, "incoming", created.release.id, "macos-arm64");
  await mkdir(incoming, { recursive: true });
  const installerName = "DeepSeek.Desktop_1.0.0_aarch64.dmg";
  const buildInfoName = "BUILD-INFO.aarch64-apple-darwin.json";
  const files = new Map([
    [installerName, Buffer.from("installer")],
    [buildInfoName, Buffer.from(`${JSON.stringify({
      application: { version: "1.0.0" },
      desktop: { commit: desktopCommit, dirty: false },
      harness: { repository: runtimeRepository, commit: runtimeCommit },
      toolchain: releaseToolchain,
      target: "aarch64-apple-darwin",
      channel: "local",
      signed: false,
      artifactAudit: { schemaVersion: 1, scannerVersion: 2, fileCount: 3, byteCount: 1024 },
      leakedPath: "/Users/developer/private"
    })}\n`)]
  ]);
  files.set("SHA256SUMS", Buffer.from(`${sha256(files.get(installerName))}  ${installerName}\n${sha256(files.get(buildInfoName))}  ${buildInfoName}\n`));
  for (const [name, bytes] of files) {
    await writeFile(join(incoming, name), bytes);
    await service.recordArtifact(claimed.taskId, claimed.lease, { name, sha256: sha256(bytes), size: bytes.length });
  }
  await assert.rejects(() => service.completeTask(claimed.taskId, claimed.lease), /macOS home path/u);
});

test("completion rejects a worker that did not use the bound prepared receipt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-release-prepared-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, service } = await createService(directory);
  const prepared = {
    schemaVersion: 1,
    receiptSha256: "1".repeat(64),
    cacheKey: "2".repeat(64),
    trackedSourceSha256: "3".repeat(64),
    generatedPayloadSha256: "4".repeat(64),
    desktopCommit,
    runtimeCommit,
    targetIds: ["macos-arm64"],
    preparedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const created = await service.createRelease({ ...releaseInput(), prepared });
  const claimed = await service.claimTask({
    ticket: created.tickets["macos-arm64"],
    targetId: "macos-arm64",
    nodeId: "local.mac.arm64"
  });
  const incoming = join(store.root, "incoming", created.release.id, "macos-arm64");
  await mkdir(incoming, { recursive: true });
  const installerName = "DeepSeek.Desktop_1.0.0_aarch64.dmg";
  const buildInfoName = "BUILD-INFO.aarch64-apple-darwin.json";
  const installer = Buffer.from("installer");
  const buildInfo = Buffer.from(`${JSON.stringify({
    application: { version: "1.0.0" },
    desktop: { commit: desktopCommit, dirty: false },
    harness: { repository: runtimeRepository, commit: runtimeCommit },
    toolchain: releaseToolchain,
    target: "aarch64-apple-darwin",
    channel: "local",
    signed: false,
    prepared: { used: false, receiptSha256: null },
    artifactAudit: { schemaVersion: 1, scannerVersion: 2, fileCount: 3, byteCount: 1024 }
  })}\n`);
  const files = new Map([
    [installerName, installer],
    [buildInfoName, buildInfo]
  ]);
  files.set("SHA256SUMS", Buffer.from(`${sha256(installer)}  ${installerName}\n${sha256(buildInfo)}  ${buildInfoName}\n`));
  for (const [name, bytes] of files) {
    await writeFile(join(incoming, name), bytes);
    await service.recordArtifact(claimed.taskId, claimed.lease, { name, sha256: sha256(bytes), size: bytes.length });
  }
  await assert.rejects(() => service.completeTask(claimed.taskId, claimed.lease), /prepared receipt/u);
});

test("release preparation and artifacts remain bound to targets and the exact Node toolchain", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-release-toolchain-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, service } = await createService(directory);
  const now = Date.now();
  const prepared = {
    schemaVersion: 1,
    receiptSha256: "1".repeat(64),
    cacheKey: "2".repeat(64),
    trackedSourceSha256: "3".repeat(64),
    generatedPayloadSha256: "4".repeat(64),
    desktopCommit,
    runtimeCommit,
    targetIds: ["macos-arm64"],
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString()
  };
  await assert.rejects(() => service.createRelease({
    ...releaseInput({ targetId: "linux-x64" }),
    prepared
  }), /target set/u);

  const created = await service.createRelease({ ...releaseInput(), prepared });
  const claimed = await service.claimTask({
    ticket: created.tickets["macos-arm64"],
    targetId: "macos-arm64",
    nodeId: "local.mac.arm64"
  });
  const incoming = join(store.root, "incoming", created.release.id, "macos-arm64");
  await mkdir(incoming, { recursive: true });
  const installerName = "DeepSeek.Desktop_1.0.0_aarch64.dmg";
  const buildInfoName = "BUILD-INFO.aarch64-apple-darwin.json";
  const installer = Buffer.from("installer");
  const buildInfo = Buffer.from(`${JSON.stringify({
    application: { version: "1.0.0" },
    desktop: { commit: desktopCommit, dirty: false },
    harness: { repository: runtimeRepository, commit: runtimeCommit },
    toolchain: { ...releaseToolchain, nodeVersion: "0.0.0" },
    target: "aarch64-apple-darwin",
    channel: "local",
    signed: false,
    prepared: { used: true, receiptSha256: prepared.receiptSha256 },
    artifactAudit: { schemaVersion: 1, scannerVersion: 2, fileCount: 3, byteCount: 1024 }
  })}\n`);
  const files = new Map([[installerName, installer], [buildInfoName, buildInfo]]);
  files.set("SHA256SUMS", Buffer.from(`${sha256(installer)}  ${installerName}\n${sha256(buildInfo)}  ${buildInfoName}\n`));
  for (const [name, bytes] of files) {
    await writeFile(join(incoming, name), bytes);
    await service.recordArtifact(claimed.taskId, claimed.lease, { name, sha256: sha256(bytes), size: bytes.length });
  }
  await assert.rejects(() => service.completeTask(claimed.taskId, claimed.lease), /toolchain/u);
});
