import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const image = "deepseek-desktop-ci-preflight:node24.16.0-playwright1.57.0";
const platform = process.env.DEEPSEEK_DESKTOP_DOCKER_PLATFORM?.trim() || "linux/amd64";
const cachePrefix = "deepseek-desktop-ci-preflight";
const emulatedAmd64 = platform === "linux/amd64" && process.arch === "arm64";

function run(args) {
  console.log(`\n> docker ${args.join(" ")}`);
  const result = spawnSync("docker", args, {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("Docker is required for the local CI preflight");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run([
  "build",
  "--platform", platform,
  "--progress", "plain",
  "--file", "docker/ci/Dockerfile",
  "--tag", image,
  "."
]);
run([
  "run",
  "--rm",
  "--platform", platform,
  "--env", "CI=true",
  ...(emulatedAmd64 ? ["--env", "DEEPSEEK_DESKTOP_SKIP_RUNTIME_SMOKE=true"] : []),
  "--volume", `${cachePrefix}-target:/workspace/target`,
  "--volume", `${cachePrefix}-rust-target:/workspace/src-tauri/target`,
  "--volume", `${cachePrefix}-pnpm:/root/.local/share/pnpm`,
  image
]);

if (emulatedAmd64) {
  console.log("\nDocker common CI passed under linux/amd64 emulation; Runtime smoke remains a native-host gate.");
}

console.log("\nDocker CI preflight passed");
