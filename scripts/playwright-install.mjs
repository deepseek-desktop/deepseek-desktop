import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const args = [require.resolve("@playwright/test/cli"), "install", "--only-shell", "chromium"];
if (process.platform === "darwin") args.push("webkit");
const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
