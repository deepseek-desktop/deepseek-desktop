import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";

const pnpmCli = process.env.npm_execpath;
const command = pnpmCli
  ? process.execPath
  : join(dirname(process.execPath), process.platform === "win32" ? "corepack.cmd" : "corepack");
const args = pnpmCli
  ? [pnpmCli, ...process.argv.slice(2)]
  : ["pnpm@11.7.0", ...process.argv.slice(2)];

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32" && !pnpmCli
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
