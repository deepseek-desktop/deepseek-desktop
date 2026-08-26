import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const pnpmVersion = packageJson.packageManager?.replace(/^pnpm@/u, "");
const channel = process.env.RELEASE_CHANNEL?.trim() || "local";
if (!pnpmVersion) throw new Error("packageManager must declare a pinned pnpm version");
if (!new Set(["local", "community", "stable"]).has(channel)) throw new Error(`unsupported release channel ${channel}`);

const targets = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", bundles: "dmg", extensions: [".dmg"], expected: 1 },
  "darwin-x64": { triple: "x86_64-apple-darwin", bundles: "dmg", extensions: [".dmg"], expected: 1 },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", bundles: "nsis", extensions: [".exe"], expected: 1 },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", bundles: "appimage,deb", extensions: [".AppImage", ".deb"], expected: 2 }
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`unsupported packaging host ${process.platform}-${process.arch}`);
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
  || join(root, "target", "playwright-browsers");

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, RELEASE_CHANNEL: channel, ...options.env },
    stdio: "inherit",
    shell: options.shell ?? false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${String(result.status)}`);
}

function runPnpm(args) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli) {
    run(process.execPath, [pnpmCli, ...args]);
    return;
  }
  const corepack = join(dirname(process.execPath), process.platform === "win32" ? "corepack.cmd" : "corepack");
  run(corepack, [`pnpm@${pnpmVersion}`, ...args], { shell: process.platform === "win32" });
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

async function assertNoEnvironmentFiles(directory) {
  const leaks = (await filesUnder(directory))
    .filter(path => /^\.env(?:\.|$)/u.test(basename(path)))
    .map(path => relative(root, path));
  if (leaks.length > 0) throw new Error(`build output contains environment files: ${leaks.join(", ")}`);
}

runPnpm(["install", "--frozen-lockfile"]);
runPnpm(["playwright:install"]);
runPnpm(["app:sync"]);
runPnpm(["runtime:sync"]);
runPnpm(["release:check", channel]);
runPnpm(["verify"]);
runPnpm(["test:e2e"]);
runPnpm(["runtime:smoke"]);

const config = JSON.parse(await readFile(join(root, "target/generated/app-config.json"), "utf8"));
const runtime = JSON.parse(await readFile(join(root, "target/generated/runtime-lock.json"), "utf8"));
const runtimeSource = JSON.parse(await readFile(join(root, "target/generated/runtime-source.json"), "utf8"));
const bundleRoot = join(root, "src-tauri", "target", "release", "bundle");
await rm(bundleRoot, { recursive: true, force: true });
const rustFlags = [process.env.RUSTFLAGS, `--remap-path-prefix=${root}=.`].filter(Boolean).join(" ");
run(process.execPath, ["scripts/with-rust.mjs", "tauri", "build", "--config", "target/generated/tauri.conf.json", "--bundles", target.bundles], {
  env: { RUSTFLAGS: rustFlags }
});

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

const dirty = git(["status", "--porcelain", "--untracked-files=all"]).length > 0;
const buildInfoPath = join(outputRoot, `BUILD-INFO.${target.triple}.json`);
await writeFile(buildInfoPath, `${JSON.stringify({
  schemaVersion: 1,
  application: {
    productName: config.productName,
    version: config.version,
    identifier: config.identifier,
    slug: config.slug,
    description: config.description,
    authors: config.authors
  },
  desktop: { commit: git(["rev-parse", "HEAD"]), dirty },
  harness: {
    repository: runtimeSource.repository,
    requestedRef: runtimeSource.requestedRef,
    commit: runtimeSource.resolvedCommit,
    packageName: runtimeSource.packageName,
    version: runtime.runtime.version,
    sha256: runtime.runtime.sha256
  },
  target: target.triple,
  channel
}, null, 2)}\n`);

await assertNoEnvironmentFiles(join(root, "target", "generated"));
await assertNoEnvironmentFiles(bundleRoot);
await assertNoEnvironmentFiles(outputRoot);
const checksumFiles = [...copiedArtifacts, buildInfoPath].sort((left, right) => basename(left).localeCompare(basename(right)));
const checksumLines = [];
for (const path of checksumFiles) checksumLines.push(`${await sha256(path)}  ${basename(path)}`);
await writeFile(join(outputRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

console.log(`\nDesktop package completed: ${outputRoot}`);
for (const path of copiedArtifacts) console.log(`- ${basename(path)}`);
console.log(`- ${basename(buildInfoPath)}`);
console.log("- SHA256SUMS");
