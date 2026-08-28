import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { assertSourceRepository, detectHostTarget, loadTargets, parseArguments, sha256File } from "../release-system/common.mjs";
import { ReleaseControllerService } from "../release-system/controller-service.mjs";
import { requestJson, uploadArtifact } from "../release-system/http-client.mjs";
import { startReleaseServer } from "../release-system/http-server.mjs";
import { ReleaseStateStore } from "../release-system/state-store.mjs";
import { loadLocalAllConfig, macPathToParallelsShared } from "../release-system/local-all.mjs";
import { scanArtifactPaths } from "../lib/artifact-scan.mjs";

const desktopCommit = "a".repeat(40);
const runtimeCommit = "b".repeat(40);
const sourceRepository = "https://example.invalid/deepseek-desktop.git";
const runtimeRepository = "https://example.invalid/deepseek-harness.git";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function releaseInput({ channel = "local", targetId = "macos-arm64", trustedNodeId = "" } = {}) {
  return {
    productName: "DeepSeek Desktop",
    version: "1.0.0",
    tag: "v1.0.0",
    channel,
    signed: false,
    source: { repository: sourceRepository, tag: "v1.0.0", commit: desktopCommit },
    runtime: { repository: runtimeRepository, ref: "v1.0.0", commit: runtimeCommit },
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

test("artifact scanner rejects environment files, local paths, and secrets", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-artifact-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clean = join(directory, "clean.bin");
  await writeFile(clean, "portable artifact");
  assert.deepEqual(await scanArtifactPaths([clean], { forbiddenRoots: [directory] }), {
    schemaVersion: 1,
    scannerVersion: 1,
    fileCount: 1,
    byteCount: 17
  });
  const secret = join(directory, "secret.bin");
  await writeFile(secret, "sk-1234567890abcdefghij1234567890");
  await assert.rejects(() => scanArtifactPaths([secret]), /API key/u);
  await writeFile(secret, "AKIAIOSFODNN7EXAMPLE");
  await scanArtifactPaths([secret]);
  await writeFile(secret, "AKIA1234567890ABCDEF");
  await assert.rejects(() => scanArtifactPaths([secret]), /AWS access key/u);
  await writeFile(secret, `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----\n`);
  await assert.rejects(() => scanArtifactPaths([secret]), /private key/u);
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
  const environment = join(directory, ".env.production");
  await writeFile(environment, "KEY=value\n");
  await assert.rejects(() => scanArtifactPaths([environment]), /environment file/u);
  const link = join(directory, "outside-link");
  await symlink(clean, link);
  await assert.rejects(() => scanArtifactPaths([link]), /symbolic link/u);
});

test("GitHub workflow pins first-party actions to immutable commits", async () => {
  const workflow = await readFile(resolve(import.meta.dirname, "../../.github/workflows/community-build.yml"), "utf8");
  const actions = [...workflow.matchAll(/uses:\s+(actions\/[^@\s]+)@([^\s#]+)/gu)];
  assert.ok(actions.length > 0);
  for (const [, name, revision] of actions) {
    assert.match(revision, /^[a-f0-9]{40}$/u, `${name} must use a full commit SHA`);
  }
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
    target: "aarch64-apple-darwin",
    channel: "local",
    signed: false,
    artifactAudit: { schemaVersion: 1, scannerVersion: 1, fileCount: 3, byteCount: 1024 }
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
      target: "aarch64-apple-darwin",
      channel: "local",
      signed: false,
      artifactAudit: { schemaVersion: 1, scannerVersion: 1, fileCount: 3, byteCount: 1024 },
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
