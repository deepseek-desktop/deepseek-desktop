import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { deployHarnessClosure, DESKTOP_EXTENSION_ROOTS, findCliPackage, findWorkspacePackages, mergeDesktopClosure } from "../lib/harness-deployment.mjs";

const [source, destination, desktop, resultFile] = process.argv.slice(2).map(value => resolve(value));
if (!source || !destination || !desktop || !resultFile) throw new Error("Repository preparation requires four paths");
const pnpm = join(desktop, "node_modules/pnpm/bin/pnpm.cjs");
function runPnpm(args, cwd = source) {
  const result = spawnSync(process.execPath, [pnpm, "--pm-on-fail=ignore", ...args], {
    cwd, stdio: "inherit", windowsHide: true,
    env: { ...process.env, CI: "true", PNPM_CONFIG_PM_ON_FAIL: "ignore" }
  });
  if (result.error || result.status !== 0) throw new Error("Harness dependency preparation failed");
}

runPnpm(["install", "--frozen-lockfile"]);
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
if (!manifest.scripts?.["build:official"]) throw new Error("Harness repository does not provide build:official");
runPnpm(["run", "build:official"]);
const workspace = await findWorkspacePackages(source);
const cli = findCliPackage(workspace);
await stat(join(cli.directory, cli.entry));
await deployHarnessClosure(source, workspace, cli, destination, runPnpm, {
  desktopDeployment: desktop, desktopRoots: DESKTOP_EXTENSION_ROOTS
});
await mergeDesktopClosure(desktop, destination, DESKTOP_EXTENSION_ROOTS);
const entry = join("node_modules", ...cli.manifest.name.split("/"), cli.entry).split(sep).join("/");
await stat(join(destination, entry));
await writeFile(resultFile, `${JSON.stringify({ version: cli.manifest.version, entry })}\n`);
