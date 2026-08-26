import { spawnSync } from "node:child_process";
import process from "node:process";

const commands = [
  ["install", "--frozen-lockfile"],
  ["app:sync"],
  ["runtime:sync"],
  ["verify"],
  ["playwright:install"],
  ["test:e2e"]
];

if (process.env.DEEPSEEK_DESKTOP_SKIP_RUNTIME_SMOKE !== "true") {
  commands.push(["runtime:smoke"]);
} else {
  console.log("Skipping Runtime smoke in an emulated Docker architecture; the native package preflight runs it next.");
}

for (const args of commands) {
  const result = spawnSync(process.execPath, ["scripts/with-pnpm.mjs", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
