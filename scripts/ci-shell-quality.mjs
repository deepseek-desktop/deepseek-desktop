import { spawnSync } from "node:child_process";
import process from "node:process";
import { createBuildSession, createStageReporter } from "./lib/build-session.mjs";

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), env: process.env, stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(" ")} exited with code ${String(result.status)}`);
}
const runPnpm = args => runNode(["scripts/with-pnpm.mjs", ...args]);
const stage = createStageReporter();
const checks = createBuildSession({ runPnpm, runNode, stage });
await stage("installMs", () => runPnpm(["install", "--frozen-lockfile"]));
await stage("appSyncMs", () => runPnpm(["app:sync"]));
await checks.verify();
await stage("playwrightInstallMs", () => runPnpm(["playwright:install"]));
await checks.e2e();

if (process.env.DEEPSEEK_DESKTOP_SKIP_HARNESS_SMOKE !== "true") {
  await checks.smoke();
} else {
  console.log("Skipping Harness smoke in an emulated Docker architecture; the native package preflight runs it next.");
}
