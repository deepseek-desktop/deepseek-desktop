import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

const pnpmCli = process.env.npm_execpath;
const command = pnpmCli
  ? process.execPath
  : join(dirname(process.execPath), process.platform === "win32" ? "corepack.cmd" : "corepack");
const args = pnpmCli
  ? [pnpmCli, ...process.argv.slice(2)]
  : ["pnpm@11.7.0", ...process.argv.slice(2)];
const nodeDirectory = dirname(process.execPath);
const environment = {
  ...process.env,
  PATH: [nodeDirectory, process.env.PATH].filter(Boolean).join(delimiter),
  npm_node_execpath: process.execPath
};

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
  shell: process.platform === "win32" && !pnpmCli
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
