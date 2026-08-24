import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = packageJson.version;
const productName = tauriConfig.productName;
const pnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, "");

if (!version || version !== tauriConfig.version) {
  throw new Error("package.json and tauri.conf.json must use the same version");
}
if (!productName) throw new Error("tauri.conf.json must declare productName");
if (!pnpmVersion) throw new Error("packageManager must declare a pinned pnpm version");

const targets = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    bundles: "dmg",
    extensions: [".dmg"],
    expectedArtifacts: 1
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    bundles: "dmg",
    extensions: [".dmg"],
    expectedArtifacts: 1
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    bundles: "nsis",
    extensions: [".exe"],
    expectedArtifacts: 1
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    bundles: "appimage,deb",
    extensions: [".AppImage", ".deb"],
    expectedArtifacts: 2
  }
};

const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`unsupported packaging host ${process.platform}-${process.arch}`);

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, RELEASE_CHANNEL: "community" },
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}`);
}

function runPnpm(args) {
  run("corepack", [`pnpm@${pnpmVersion}`, ...args]);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

runPnpm(["install", "--frozen-lockfile"]);
runPnpm(["--dir", "runtime", "install", "--frozen-lockfile"]);
runPnpm(["release:check", "community"]);
runPnpm(["verify"]);
runPnpm(["test:e2e"]);
runPnpm(["runtime:smoke"]);

const bundleRoot = join(root, "src-tauri/target/release/bundle");
await rm(bundleRoot, { recursive: true, force: true });
run(process.execPath, ["scripts/with-rust.mjs", "tauri", "build", "--bundles", target.bundles]);

const artifacts = (await filesUnder(bundleRoot))
  .filter(path => target.extensions.some(extension => path.endsWith(extension)))
  .sort();
if (artifacts.length !== target.expectedArtifacts) {
  throw new Error(`expected ${target.expectedArtifacts} installer artifact(s), found ${artifacts.length}`);
}

if (process.platform === "darwin") {
  const mountPoint = join(root, "target/package-community-mount");
  for (const artifact of artifacts) {
    run("hdiutil", ["verify", artifact]);
    await rm(mountPoint, { recursive: true, force: true });
    await mkdir(mountPoint, { recursive: true });
    let mounted = false;
    try {
      run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, artifact]);
      mounted = true;
      run("codesign", ["--verify", "--deep", "--strict", join(mountPoint, `${productName}.app`)]);
    } finally {
      if (mounted) run("hdiutil", ["detach", mountPoint]);
      await rm(mountPoint, { recursive: true, force: true });
    }
  }
}

const outputRoot = join(root, "release", version);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const copiedArtifacts = [];
for (const artifact of artifacts) {
  const output = join(outputRoot, basename(artifact));
  await copyFile(artifact, output);
  copiedArtifacts.push(output);
}

const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (commit.status !== 0) throw new Error("could not resolve the source commit");
const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status !== 0) throw new Error("could not inspect the source worktree");
const buildInfo = join(outputRoot, "BUILD-INFO.json");
await writeFile(buildInfo, `${JSON.stringify({
  product: tauriConfig.productName,
  version,
  commit: commit.stdout.trim(),
  dirty: status.stdout.trim().length > 0,
  target: target.triple,
  channel: "community"
}, null, 2)}\n`);

const checksumFiles = [...copiedArtifacts, buildInfo].sort((left, right) => basename(left).localeCompare(basename(right)));
const checksumLines = [];
for (const path of checksumFiles) checksumLines.push(`${await sha256(path)}  ${basename(path)}`);
await writeFile(join(outputRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

console.log(`\nCommunity package completed: ${outputRoot}`);
for (const path of copiedArtifacts) console.log(`- ${basename(path)}`);
console.log("- BUILD-INFO.json");
console.log("- SHA256SUMS");
