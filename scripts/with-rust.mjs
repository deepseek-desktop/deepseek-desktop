import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (rootResult.status !== 0) throw new Error("could not locate the repository root");
const projectRoot = rootResult.stdout.trim();
const desktopRoot = resolve(import.meta.dirname, "..");
const toolchainRoot = resolve(process.env.DSH_DESKTOP_TOOLCHAIN_DIR || join(projectRoot, "target/dsh-desktop-toolchain"));
const cargoHome = join(toolchainRoot, "cargo");
const rustupHome = join(toolchainRoot, "rustup");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const rustup = join(cargoHome, "bin", `rustup${executableSuffix}`);
const environment = {
  ...process.env,
  CARGO_HOME: cargoHome,
  RUSTUP_HOME: rustupHome,
  PATH: [join(cargoHome, "bin"), join(desktopRoot, "node_modules", ".bin"), process.env.PATH || ""].join(delimiter)
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: environment, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

if (!await exists(rustup)) {
  const triples = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc"
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  if (!triple) throw new Error(`unsupported Rust bootstrap host ${process.platform}-${process.arch}`);
  await mkdir(toolchainRoot, { recursive: true });
  const installer = join(toolchainRoot, `rustup-init${executableSuffix}`);
  const url = `https://static.rust-lang.org/rustup/dist/${triple}/rustup-init${executableSuffix}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download rustup-init: HTTP ${response.status}`);
  await writeFile(installer, new Uint8Array(await response.arrayBuffer()));
  if (process.platform !== "win32") await chmod(installer, 0o755);
  run(installer, ["-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", "1.98.0"]);
}

const installed = spawnSync(rustup, ["run", "1.98.0", "rustc", "--version"], { env: environment, stdio: "ignore" });
if (installed.status !== 0) run(rustup, ["toolchain", "install", "1.98.0", "--profile", "minimal"]);

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("a command is required");
run(command, args, { shell: process.platform === "win32" });
