import { spawnSync } from "node:child_process";
import process from "node:process";

for (const script of ["preflight:docker", "desktop:package"]) {
  const result = spawnSync(process.execPath, ["scripts/with-pnpm.mjs", script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nLocal release preflight passed for Docker and the native host");
