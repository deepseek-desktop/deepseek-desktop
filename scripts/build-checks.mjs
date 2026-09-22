import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createBuildSession, createStageReporter } from "./lib/build-session.mjs";

const root = resolve(import.meta.dirname, "..");
function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(" ")} exited with code ${String(result.status)}`);
}
const session = createBuildSession({
  runNode,
  runPnpm: args => runNode(["scripts/with-pnpm.mjs", ...args]),
  stage: createStageReporter()
});
const [check, ...args] = process.argv.slice(2);
if (check === "verify" && args.length === 0) await session.verify();
else if (check === "e2e") await session.e2e(args);
else throw new Error("usage: build-checks.mjs verify | e2e [Playwright options]");
