import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { createMacDmg } from "./macos-dmg.mjs";
import { loadBuildConfig } from "./lib/build-config.mjs";
import { artifactForbiddenRoots, scanArtifactPaths } from "./lib/artifact-scan.mjs";
import { restorePreparedRelease } from "./release-system/prepared-release.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const pnpmVersion = packageJson.packageManager?.replace(/^pnpm@/u, "");
const resolvedConfig = await loadBuildConfig(root);
const channel = resolvedConfig.release.channel;
if (!pnpmVersion) throw new Error("packageManager must declare a pinned pnpm version");
if (!new Set(["local", "community", "stable"]).has(channel)) throw new Error(`unsupported release channel ${channel}`);

const targets = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", bundles: "app", extensions: [".dmg"], expected: 1, dmgArch: "aarch64" },
  "darwin-x64": { triple: "x86_64-apple-darwin", bundles: "app", extensions: [".dmg"], expected: 1, dmgArch: "x64" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", bundles: "nsis", extensions: [".exe"], expected: 1 },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", bundles: "appimage,deb", extensions: [".AppImage", ".deb"], expected: 2 }
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`unsupported packaging host ${process.platform}-${process.arch}`);
const forbiddenRoots = artifactForbiddenRoots(root);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
  || join(root, "target", "playwright-browsers");

function run(command, args, options = {}) {
  const startedAt = Date.now();
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, RELEASE_CHANNEL: channel, RELEASE_SIGNED: String(resolvedConfig.release.signed), ...options.env },
    stdio: "inherit",
    shell: options.shell ?? false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${String(result.status)}`);
  return Date.now() - startedAt;
}

function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli) {
    return run(process.execPath, [pnpmCli, ...args]);
  }
  const corepack = join(dirname(process.execPath), process.platform === "win32" ? "corepack.cmd" : "corepack");
  return run(corepack, [`pnpm@${pnpmVersion}`, ...args], { shell: process.platform === "win32" });
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const packageStartedAt = Date.now();
const timings = {};
const preparedRoot = process.env.DEEPSEEK_DESKTOP_PREPARED_ROOT?.trim() || "";
const preparedDescriptorText = process.env.DEEPSEEK_DESKTOP_PREPARED_DESCRIPTOR?.trim() || "";
const releasePlanText = process.env.DEEPSEEK_DESKTOP_RELEASE_PLAN?.trim() || "";
const preparedValueCount = [preparedRoot, preparedDescriptorText, releasePlanText].filter(Boolean).length;
if (preparedValueCount !== 0 && preparedValueCount !== 3) {
  throw new Error("prepared packaging requires a cache root, descriptor, and controller release plan together");
}
const preparedMode = Boolean(preparedRoot);
let preparedReceiptSha256 = "";
if (preparedMode) {
  const restoredAt = Date.now();
  const restored = await restorePreparedRelease({
    root,
    preparedRoot,
    expectedDescriptor: JSON.parse(preparedDescriptorText),
    plan: JSON.parse(releasePlanText)
  });
  preparedReceiptSha256 = restored.descriptor.receiptSha256;
  timings.preparedRestoreMs = Date.now() - restoredAt;
  timings.installMs = runPnpm(["install", "--frozen-lockfile"]);
  timings.appSyncCheckMs = runPnpm(["app:sync", "--check"]);
  timings.releaseGateMs = runPnpm(["release:check", channel]);
  timings.runtimeStageMs = runPnpm(["runtime:stage"]);
  timings.runtimeSmokeMs = runPnpm(["runtime:smoke"]);
} else {
  timings.installMs = runPnpm(["install", "--frozen-lockfile"]);
  timings.playwrightInstallMs = runPnpm(["playwright:install"]);
  timings.appSyncMs = runPnpm(["app:sync"]);
  timings.runtimeSyncMs = runPnpm(["runtime:sync"]);
  timings.releaseGateMs = runPnpm(["release:check", channel]);
  timings.verifyMs = runPnpm(["verify"]);
  timings.e2eMs = runPnpm(["test:e2e"]);
  timings.runtimeSmokeMs = runPnpm(["runtime:smoke"]);
}

const config = JSON.parse(await readFile(join(root, "target/generated/app-config.json"), "utf8"));
const runtime = JSON.parse(await readFile(join(root, "target/generated/runtime-lock.json"), "utf8"));
const runtimeSource = JSON.parse(await readFile(join(root, "target/generated/runtime-source.json"), "utf8"));
const toolchainLock = JSON.parse(await readFile(join(root, "runtime", "toolchain-lock.json"), "utf8"));
const cargoCacheRoot = resolve(process.env.DEEPSEEK_DESKTOP_CARGO_CACHE_ROOT?.trim() || join(root, "src-tauri", "target"));
const cargoCacheKey = createHash("sha256").update(JSON.stringify({
  target: target.triple,
  rust: toolchainLock.toolchain?.rust,
  channel,
  signed: resolvedConfig.release.signed,
  rustFlags: process.env.RUSTFLAGS || "",
  profile: "release"
})).digest("hex").slice(0, 20);
const cargoTargetDir = process.env.DEEPSEEK_DESKTOP_CARGO_CACHE_ROOT?.trim()
  ? join(cargoCacheRoot, target.triple, cargoCacheKey)
  : cargoCacheRoot;
process.env.CARGO_TARGET_DIR = cargoTargetDir;
const bundleRoot = join(cargoTargetDir, "release", "bundle");
await rm(bundleRoot, { recursive: true, force: true });
const rustFlags = [
  process.env.RUSTFLAGS,
  `--remap-path-prefix=${root}=.`,
  ...(cargoTargetDir !== join(root, "src-tauri", "target") ? [`--remap-path-prefix=${cargoTargetDir}=./target/cargo-cache`] : [])
].filter(Boolean).join(" ");
timings.tauriBuildMs = run(process.execPath, ["scripts/with-rust.mjs", "tauri", "build", "--config", "target/generated/tauri.conf.json", "--bundles", target.bundles], {
  env: { RUSTFLAGS: rustFlags }
});
if (target.dmgArch) {
  await createMacDmg({
    bundleRoot,
    productName: config.productName,
    version: config.version,
    architecture: target.dmgArch
  });
}

const artifacts = (await filesUnder(bundleRoot))
  .filter(path => target.extensions.some(extension => path.endsWith(extension)))
  .sort();
if (artifacts.length !== target.expected) throw new Error(`expected ${target.expected} installer artifact(s), found ${artifacts.length}`);

const outputRoot = join(root, "release", config.version, target.triple);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const copiedArtifacts = [];
for (const artifact of artifacts) {
  const output = join(outputRoot, basename(artifact));
  await copyFile(artifact, output);
  copiedArtifacts.push(output);
}

const primaryBinary = join(
  cargoTargetDir,
  "release",
  `${packageJson.name}${process.platform === "win32" ? ".exe" : ""}`
);
const scanRoots = [
  join(root, "dist"),
  join(root, "target", "generated", "app-config.json"),
  join(root, "target", "generated", "tauri.conf.json"),
  join(root, "target", "generated", "runtime-source.json"),
  join(root, "target", "generated", "runtime-lock.json"),
  join(root, "target", "generated", "branding"),
  join(root, "runtime", "staging", target.triple),
  bundleRoot,
  ...await stat(primaryBinary).then(() => [primaryBinary], () => [])
];
const artifactAudit = await scanArtifactPaths(scanRoots, {
  forbiddenRoots
});

const dirty = git(["status", "--porcelain", "--untracked-files=all"]).length > 0;
let runtimeCache = { hit: false, key: "unknown" };
try {
  runtimeCache = JSON.parse(await readFile(join(root, "target", "local-release", `runtime-cache-${target.triple}.json`), "utf8"));
} catch {}
timings.totalMs = Date.now() - packageStartedAt;
const buildInfoPath = join(outputRoot, `BUILD-INFO.${target.triple}.json`);
await writeFile(buildInfoPath, `${JSON.stringify({
  schemaVersion: 1,
  application: {
    productName: config.productName,
    version: config.version,
    identifier: config.identifier,
    slug: config.slug,
    description: config.description,
    authors: config.authors,
    repository: config.repository
  },
  desktop: { commit: git(["rev-parse", "HEAD"]), dirty },
  harness: {
    repository: runtimeSource.repository,
    requestedRef: runtimeSource.requestedRef,
    resolvedRef: runtimeSource.resolvedRef,
    commit: runtimeSource.resolvedCommit,
    packageName: runtimeSource.packageName,
    version: runtime.runtime.version,
    sha256: runtime.runtime.sha256
  },
  target: target.triple,
  channel,
  signed: config.release.signed,
  prepared: {
    used: preparedMode,
    receiptSha256: preparedReceiptSha256 || null
  },
  performance: {
    schemaVersion: 1,
    timings,
    runtimeCache,
    cargoCache: { key: cargoCacheKey, persistent: Boolean(process.env.DEEPSEEK_DESKTOP_CARGO_CACHE_ROOT?.trim()) }
  },
  runtimeUpdate: {
    enabled: Boolean(config.runtimeUpdate.manifestUrl && config.runtimeUpdate.publicKey),
    channel: config.runtimeUpdate.channel,
    publisher: config.runtimeUpdate.publisher,
    desktopProtocolVersion: config.runtimeUpdate.desktopProtocolVersion,
    runtimeProtocolVersion: config.runtimeUpdate.runtimeProtocolVersion,
    credentialProtocolVersion: config.runtimeUpdate.credentialProtocolVersion
  },
  artifactAudit
}, null, 2)}\n`);

await scanArtifactPaths([...copiedArtifacts, buildInfoPath], {
  forbiddenRoots
});
const checksumFiles = [...copiedArtifacts, buildInfoPath].sort((left, right) => basename(left).localeCompare(basename(right)));
const checksumLines = [];
for (const path of checksumFiles) checksumLines.push(`${await sha256(path)}  ${basename(path)}`);
await writeFile(join(outputRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

console.log(`\nDesktop package completed: ${outputRoot.slice(root.length + 1)}`);
for (const path of copiedArtifacts) console.log(`- ${basename(path)}`);
console.log(`- ${basename(buildInfoPath)}`);
console.log("- SHA256SUMS");
