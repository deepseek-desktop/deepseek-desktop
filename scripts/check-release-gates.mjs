import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const windowsGuiDeclaration = '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]';
const rustMain = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
if (!rustMain.includes(windowsGuiDeclaration)) {
  throw new Error("Windows release must use the GUI subsystem so it does not open a console window");
}

const rustRuntime = readFileSync(new URL("../src-tauri/src/runtime.rs", import.meta.url), "utf8");
if (!rustRuntime.includes("command.creation_flags(CREATE_NO_WINDOW)")) {
  throw new Error("Windows Runtime must start without a console window");
}
if (!rustRuntime.includes('"--no-open"')) {
  throw new Error("Desktop Runtime must not hand off to the system browser");
}

const channel = process.argv[2] || "local";
const config = JSON.parse(readFileSync(join(root, "target/generated/app-config.json"), "utf8"));
if (config.release?.channel !== channel) {
  throw new Error(`release gate channel ${channel} does not match generated configuration ${String(config.release?.channel)}`);
}
if (channel === "local") {
  console.log("local package gate passed: source dirtiness will be recorded in BUILD-INFO");
  process.exit(0);
}
if (channel !== "community" && channel !== "stable") throw new Error(`unsupported release channel ${channel}`);

const status = git(["status", "--porcelain", "--untracked-files=all"]);
if (status) throw new Error(`${channel} release requires a clean worktree`);
const expectedTag = `v${config.version}`;
const headTags = git(["tag", "--points-at", "HEAD"]).split("\n").filter(Boolean);
if (!headTags.includes(expectedTag)) throw new Error(`${channel} release requires tag ${expectedTag} on HEAD`);
if (channel === "community") {
  if (config.release.signed) throw new Error("community release must not claim a trusted publisher signature");
  console.log(`community release gate passed for ${expectedTag}; artifacts remain explicitly unsigned`);
  process.exit(0);
}

const required = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "DEEPSEEK_DESKTOP_UPDATER_PUBKEY",
  "DEEPSEEK_DESKTOP_UPDATER_ENDPOINT",
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD"
];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`stable release is blocked; missing signing configuration: ${missing.join(", ")}`);
}
if (!config.release.signed) throw new Error("stable release must set RELEASE_SIGNED=true");
console.log("stable release signing gate passed");
