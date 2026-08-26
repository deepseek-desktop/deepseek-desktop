import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";

const desktopRoot = resolve(import.meta.dirname, "..");
const toolchainRoot = resolve(process.env.DEEPSEEK_DESKTOP_TOOLCHAIN_DIR || join(desktopRoot, "target/deepseek-desktop-toolchain"));
const cargoHome = join(toolchainRoot, "cargo");
const rustupHome = join(toolchainRoot, "rustup");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const rustup = join(cargoHome, "bin", `rustup${executableSuffix}`);
const require = createRequire(import.meta.url);
const triples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc"
};
const triple = triples[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`unsupported Rust bootstrap host ${process.platform}-${process.arch}`);
const rustToolchain = `1.98.0-${triple}`;
const generatedTauriConfigPath = join(desktopRoot, "target", "generated", "tauri.conf.json");
let generatedTauriConfig;
try {
  generatedTauriConfig = await readFile(generatedTauriConfigPath, "utf8");
} catch {
  generatedTauriConfig = undefined;
}
const environment = {
  ...process.env,
  CARGO_HOME: cargoHome,
  RUSTUP_HOME: rustupHome,
  RUSTUP_TOOLCHAIN: rustToolchain,
  ...(generatedTauriConfig ? { TAURI_CONFIG: generatedTauriConfig } : {}),
  ...(process.platform === "win32" ? { RUSTUP_USE_CURL: "1" } : {}),
  PATH: [join(cargoHome, "bin"), join(desktopRoot, "node_modules", ".bin"), process.env.PATH || ""].join(delimiter)
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: environment, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}`);
}

function runWithRetry(command, args, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(command, args);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      const delaySeconds = attempt * 3;
      console.warn(`${command} failed; retrying in ${delaySeconds}s (${attempt}/${attempts})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delaySeconds * 1_000);
    }
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadWithCurl(url, output) {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  run(curl, [
    "--fail",
    "--location",
    "--retry", "5",
    "--retry-all-errors",
    "--retry-delay", "2",
    "--connect-timeout", "30",
    "--max-time", "300",
    "--output", output,
    url
  ]);
}

async function prefetchWindowsToolchain(components = ["cargo", "rust-std", "rustc", "clippy"]) {
  const manifest = join(toolchainRoot, "channel-rust-1.98.0.toml");
  await downloadWithCurl("https://static.rust-lang.org/dist/channel-rust-1.98.0.toml", manifest);
  const content = await readFile(manifest, "utf8");
  const downloads = join(rustupHome, "downloads");
  await mkdir(downloads, { recursive: true });
  const escapedTriple = triple.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const manifestPackages = {
    clippy: "clippy-preview"
  };

  for (const component of components) {
    const manifestPackage = manifestPackages[component] || component;
    const escapedPackage = manifestPackage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const section = content.match(new RegExp(`\\[pkg\\.${escapedPackage}\\.target\\.${escapedTriple}\\]\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[|$)`, "u"));
    const url = section?.[1].match(/^xz_url = "([^"]+)"$/mu)?.[1];
    const expectedHash = section?.[1].match(/^xz_hash = "([0-9a-f]{64})"$/mu)?.[1];
    if (!url || !expectedHash) throw new Error(`Rust manifest is missing ${component} for ${triple}`);

    const cached = join(downloads, expectedHash);
    if (await exists(cached) && await sha256(cached) === expectedHash) continue;
    const partial = `${cached}.partial`;
    await rm(partial, { force: true });
    await downloadWithCurl(url, partial);
    const actualHash = await sha256(partial);
    if (actualHash !== expectedHash) throw new Error(`${component} checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
    await rename(partial, cached);
  }
}

if (!await exists(rustup)) {
  await mkdir(toolchainRoot, { recursive: true });
  const installer = join(toolchainRoot, `rustup-init${executableSuffix}`);
  const url = `https://static.rust-lang.org/rustup/dist/${triple}/rustup-init${executableSuffix}`;
  if (process.platform === "win32") {
    await downloadWithCurl(url, installer);
    await prefetchWindowsToolchain();
  } else {
    await downloadWithCurl(url, installer);
    await chmod(installer, 0o755);
  }
  runWithRetry(installer, [
    "-y",
    "--no-modify-path",
    "--profile", "minimal",
    "--default-host", triple,
    "--default-toolchain", rustToolchain,
    "--component", "clippy"
  ]);
}

const installed = spawnSync(rustup, ["run", rustToolchain, "rustc", "--version"], { env: environment, stdio: "ignore" });
if (installed.status !== 0) {
  runWithRetry(rustup, ["toolchain", "install", rustToolchain, "--profile", "minimal"]);
}

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("a command is required");
if (process.platform === "win32" && command === "rustup" && args.includes("clippy")) {
  const componentList = spawnSync(rustup, ["component", "list", "--installed", "--toolchain", rustToolchain], {
    env: environment,
    encoding: "utf8"
  });
  if (componentList.status !== 0 || !componentList.stdout.split(/\r?\n/u).some(value => value.startsWith("clippy-"))) {
    await prefetchWindowsToolchain(["clippy"]);
  }
}

let executable = command;
let commandArgs = args;
if (process.platform === "win32") {
  if (command === "cargo") executable = join(cargoHome, "bin", "cargo.exe");
  else if (command === "rustup") executable = rustup;
  else if (command === "tauri") {
    executable = process.execPath;
    commandArgs = [require.resolve("@tauri-apps/cli/tauri.js"), ...args];
  }
}
run(executable, commandArgs);
