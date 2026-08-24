import { spawnSync } from "node:child_process";
import process from "node:process";

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  console.error("pnpm executable is unavailable; run this command through corepack pnpm@11.7.0");
  process.exit(1);
}

const result = spawnSync(process.execPath, [pnpmCli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
