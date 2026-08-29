import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

import { atomicWriteJson, sha256File } from "./common.mjs";
import { loadBuildConfig } from "../lib/build-config.mjs";
import { parseReleaseTag } from "../lib/release-tag.mjs";

const shaPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const payloadEntries = Object.freeze([
  "app-config.json",
  "tauri.conf.json",
  "branding",
  "runtime-source.json",
  "runtime-lock.json",
  "runtime/prepared"
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonical(value)), "utf8");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function run(command, args, { cwd, env = process.env } = {}) {
  const startedAt = Date.now();
  console.log(`\n> ${command} ${args.join(" ")}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} ${args.join(" ")} exited with code ${String(code)}`)));
  });
  return Date.now() - startedAt;
}

async function collectTree(root, current = root, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const portablePath = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`prepared cache cannot contain symbolic links: ${portablePath}`);
    }
    if (entry.isDirectory()) await collectTree(root, path, output);
    else if (entry.isFile()) {
      const info = await stat(path);
      output.push({ path: portablePath, size: info.size, sha256: await sha256File(path) });
    }
  }
  return output;
}

async function trackedSourceHash(root) {
  const output = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
  if (output.error) throw output.error;
  if (output.status !== 0) throw new Error(`git ls-files failed: ${output.stderr.toString("utf8").trim()}`);
  const files = output.stdout.toString("utf8").split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const path = join(root, file);
    const info = await lstat(path);
    hash.update(file).update("\0");
    if (info.isSymbolicLink()) hash.update("link\0").update(await readlink(path));
    else if (info.isFile()) hash.update("file\0").update(await readFile(path));
    else throw new Error(`tracked release input is not a file or link: ${file}`);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertPreparedDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("prepared release descriptor must be an object");
  if (value.schemaVersion !== 1) throw new Error("unsupported prepared release descriptor");
  for (const key of ["receiptSha256", "cacheKey", "trackedSourceSha256", "generatedPayloadSha256"]) {
    if (!shaPattern.test(value[key] || "")) throw new Error(`prepared release ${key} must be SHA-256`);
  }
  if (!commitPattern.test(value.desktopCommit || "") || !commitPattern.test(value.runtimeCommit || "")) {
    throw new Error("prepared release commits must be full Git commits");
  }
  return value;
}

export function verifyPreparedReceipt(receipt) {
  if (!receipt || receipt.schemaVersion !== 1 || !receipt.payload || typeof receipt.signature !== "string" || typeof receipt.publicKey !== "string") {
    throw new Error("invalid prepared release receipt");
  }
  const publicKey = Buffer.from(receipt.publicKey, "base64");
  if (publicKey.length !== 44) throw new Error("prepared release public key is invalid");
  const key = { key: publicKey, format: "der", type: "spki" };
  if (!verify(null, canonicalBytes(receipt.payload), key, Buffer.from(receipt.signature, "base64"))) {
    throw new Error("prepared release receipt signature is invalid");
  }
  return receipt.payload;
}

async function verifyPayload(directory, expectedFiles, expectedTreeHash) {
  const files = await collectTree(directory);
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) throw new Error("prepared release payload file manifest does not match cache contents");
  const treeHash = sha256Bytes(canonicalBytes(files));
  if (treeHash !== expectedTreeHash) throw new Error("prepared release payload hash does not match receipt");
  return files;
}

async function restorePayload(payloadRoot, generatedRoot) {
  await rm(generatedRoot, { recursive: true, force: true });
  await mkdir(generatedRoot, { recursive: true });
  for (const entry of payloadEntries) {
    await cp(join(payloadRoot, entry), join(generatedRoot, entry), { recursive: true, force: true });
  }
}

function preparationInput({ tag, version, channel, signed, desktopCommit, runtime, trackedSourceSha256, configSha256, lock }) {
  return {
    schemaVersion: 1,
    tag,
    version,
    channel,
    signed,
    desktopCommit,
    runtime: { repository: runtime.repository, ref: runtime.ref, commit: runtime.commit },
    trackedSourceSha256,
    configSha256,
    node: { version: process.versions.node, abi: process.versions.modules },
    toolchain: lock.toolchain,
    packageManager: "pnpm@11.7.0"
  };
}

function receiptMatchesInput(payload, input, cacheKey) {
  if (payload.cacheKey !== cacheKey) return false;
  const actual = Object.fromEntries(Object.keys(input).map(key => [key, payload[key]]));
  return canonicalBytes(actual).equals(canonicalBytes(input));
}

async function readPreparedRuntime(payloadRoot, expectedCommit) {
  const generatedLock = JSON.parse(await readFile(join(payloadRoot, "runtime-lock.json"), "utf8"));
  const generatedSource = JSON.parse(await readFile(join(payloadRoot, "runtime-source.json"), "utf8"));
  if (generatedSource.resolvedCommit !== expectedCommit || generatedLock.runtime?.commit !== expectedCommit) {
    throw new Error("prepared Runtime does not match runtime/toolchain-lock.json");
  }
  return { generatedLock, generatedSource };
}

export async function prepareRelease({
  root,
  tag,
  channel = "community",
  signed = false,
  cacheRoot = join(root, "target", "local-release", "prepared"),
  runChecks = true
}) {
  const workspace = resolve(root);
  const { version } = parseReleaseTag(tag);
  if (git(workspace, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("release preparation requires a clean Desktop worktree");
  }
  const desktopCommit = git(workspace, ["rev-parse", "HEAD"]);
  if (git(workspace, ["rev-parse", `${tag}^{commit}`]) !== desktopCommit) {
    throw new Error(`release tag ${tag} must point at current HEAD before preparation`);
  }
  const lock = JSON.parse(await readFile(join(workspace, "runtime", "toolchain-lock.json"), "utf8"));
  const runtime = lock.runtimeSource;
  if (!runtime?.repository || !runtime?.ref || !commitPattern.test(runtime?.commit || "")) {
    throw new Error("runtime/toolchain-lock.json has no immutable Runtime source");
  }
  const environment = {
    ...process.env,
    DESKTOP_APP_VERSION: version,
    RUNTIME_REPOSITORY: runtime.repository,
    RUNTIME_REF: runtime.commit,
    RELEASE_CHANNEL: channel,
    RELEASE_SIGNED: String(signed)
  };
  const trackedSourceSha256 = await trackedSourceHash(workspace);
  const resolvedConfig = runChecks
    ? await loadBuildConfig(workspace, { environment })
    : { version, release: { channel, signed }, harness: { repository: runtime.repository, ref: runtime.commit } };
  const configSha256 = sha256Bytes(canonicalBytes(resolvedConfig));
  const cacheKeyInput = preparationInput({
    tag,
    version,
    channel,
    signed,
    desktopCommit,
    runtime,
    trackedSourceSha256,
    configSha256,
    lock
  });
  const cacheKey = sha256Bytes(canonicalBytes(cacheKeyInput));
  const destination = join(cacheRoot, cacheKey);
  const generatedRoot = join(workspace, "target", "generated");
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const timings = {};
  try {
    const existingReceiptPath = join(destination, "receipt.json");
    const existingReceipt = JSON.parse(await readFile(existingReceiptPath, "utf8"));
    const existingPayload = verifyPreparedReceipt(existingReceipt);
    if (!receiptMatchesInput(existingPayload, cacheKeyInput, cacheKey)) {
      throw new Error("prepared release receipt input identity changed");
    }
    const payloadRoot = join(destination, "payload");
    await verifyPayload(payloadRoot, existingPayload.files, existingPayload.generatedPayloadSha256);
    await readPreparedRuntime(payloadRoot, runtime.commit);
    const existingDescriptor = assertPreparedDescriptor({
      schemaVersion: 1,
      receiptSha256: await sha256File(existingReceiptPath),
      cacheKey,
      trackedSourceSha256,
      generatedPayloadSha256: existingPayload.generatedPayloadSha256,
      desktopCommit,
      runtimeCommit: runtime.commit
    });
    await restorePayload(payloadRoot, generatedRoot);
    await atomicWriteJson(join(destination, "descriptor.json"), existingDescriptor);
    return {
      descriptor: existingDescriptor,
      directory: destination,
      receiptPath: existingReceiptPath,
      timings,
      cacheHit: true
    };
  } catch {
    await rm(destination, { recursive: true, force: true });
  }
  if (runChecks) {
    timings.installMs = await run(corepack, ["pnpm@11.7.0", "install", "--frozen-lockfile"], { cwd: workspace, env: environment });
    timings.playwrightInstallMs = await run(corepack, ["pnpm@11.7.0", "playwright:install"], { cwd: workspace, env: environment });
    timings.appSyncMs = await run(corepack, ["pnpm@11.7.0", "app:sync"], { cwd: workspace, env: environment });
    timings.runtimeSyncMs = await run(corepack, ["pnpm@11.7.0", "runtime:sync"], { cwd: workspace, env: environment });
    timings.releaseGateMs = await run(corepack, ["pnpm@11.7.0", "release:check", channel], { cwd: workspace, env: environment });
    timings.verifyMs = await run(corepack, ["pnpm@11.7.0", "verify"], { cwd: workspace, env: environment });
    timings.e2eMs = await run(corepack, ["pnpm@11.7.0", "test:e2e"], { cwd: workspace, env: environment });
  }
  if (git(workspace, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("release preparation checks changed the Desktop worktree");
  }
  if (git(workspace, ["rev-parse", "HEAD"]) !== desktopCommit
    || git(workspace, ["rev-parse", `${tag}^{commit}`]) !== desktopCommit
    || await trackedSourceHash(workspace) !== trackedSourceSha256) {
    throw new Error("release preparation source changed while checks were running");
  }
  const generatedLock = JSON.parse(await readFile(join(generatedRoot, "runtime-lock.json"), "utf8"));
  const generatedSource = JSON.parse(await readFile(join(generatedRoot, "runtime-source.json"), "utf8"));
  if (generatedSource.resolvedCommit !== runtime.commit || generatedLock.runtime?.commit !== runtime.commit) {
    throw new Error("prepared Runtime does not match runtime/toolchain-lock.json");
  }
  const temporary = join(cacheRoot, `.prepare-${process.pid}-${Date.now()}`);
  const payloadRoot = join(temporary, "payload");
  await rm(temporary, { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true });
  for (const entry of payloadEntries) {
    const source = join(generatedRoot, entry);
    await stat(source);
    await cp(source, join(payloadRoot, entry), { recursive: true, force: true });
  }
  const files = await collectTree(payloadRoot);
  const generatedPayloadSha256 = sha256Bytes(canonicalBytes(files));
  const payload = {
    ...cacheKeyInput,
    cacheKey,
    generatedPayloadSha256,
    files,
    preparedAt: new Date().toISOString()
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const receipt = {
    schemaVersion: 1,
    payload,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signature: sign(null, canonicalBytes(payload), privateKey).toString("base64")
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const receiptSha256 = sha256Bytes(receiptBytes);
  await writeFile(join(temporary, "receipt.json"), receiptBytes, { mode: 0o600 });
  await mkdir(cacheRoot, { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  const descriptor = assertPreparedDescriptor({
    schemaVersion: 1,
    receiptSha256,
    cacheKey,
    trackedSourceSha256,
    generatedPayloadSha256,
    desktopCommit,
    runtimeCommit: runtime.commit
  });
  await atomicWriteJson(join(destination, "descriptor.json"), descriptor);
  return { descriptor, directory: destination, receiptPath: join(destination, "receipt.json"), timings, cacheHit: false };
}

export async function restorePreparedRelease({ root, preparedRoot, expectedDescriptor, plan }) {
  const descriptor = assertPreparedDescriptor(expectedDescriptor);
  const directory = join(resolve(preparedRoot), descriptor.cacheKey);
  const receiptPath = join(directory, "receipt.json");
  if (await sha256File(receiptPath) !== descriptor.receiptSha256) throw new Error("prepared release receipt SHA-256 does not match release plan");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const payload = verifyPreparedReceipt(receipt);
  for (const key of ["cacheKey", "trackedSourceSha256", "generatedPayloadSha256"]) {
    if (payload[key] !== descriptor[key]) throw new Error(`prepared release ${key} does not match controller plan`);
  }
  if (payload.desktopCommit !== plan.source.commit || payload.desktopCommit !== descriptor.desktopCommit) {
    throw new Error("prepared release Desktop commit does not match controller plan");
  }
  if (payload.runtime.commit !== plan.runtime.commit || payload.runtime.commit !== descriptor.runtimeCommit) {
    throw new Error("prepared release Runtime commit does not match controller plan");
  }
  if (payload.tag !== plan.tag || payload.version !== plan.version || payload.channel !== plan.channel || payload.signed !== plan.signed) {
    throw new Error("prepared release identity does not match controller plan");
  }
  const workspace = resolve(root);
  if (git(workspace, ["rev-parse", "HEAD"]) !== plan.source.commit) throw new Error("prepared worker checkout commit changed");
  if (git(workspace, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("prepared worker checkout must remain clean");
  if (await trackedSourceHash(workspace) !== descriptor.trackedSourceSha256) throw new Error("prepared worker source inputs changed");
  const payloadRoot = join(directory, "payload");
  await verifyPayload(payloadRoot, payload.files, descriptor.generatedPayloadSha256);
  const generatedRoot = join(workspace, "target", "generated");
  await restorePayload(payloadRoot, generatedRoot);
  return { descriptor, payload };
}

export { assertPreparedDescriptor, trackedSourceHash };
