import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { deployHarnessClosure, DESKTOP_EXTENSION_ROOTS, findCliPackage, findWorkspacePackages, mergeDesktopClosure } from "../lib/harness-deployment.mjs";
import { applyDesktopCompatibilityPatches } from "../lib/desktop-patches.mjs";

const [source, destination, desktop, resultFile] = process.argv.slice(2).map(value => resolve(value));
if (!source || !destination || !desktop || !resultFile) throw new Error("Repository preparation requires four paths");
const pnpm = join(desktop, "node_modules/pnpm/bin/pnpm.cjs");
const npm = join(desktop, "toolchain/node/npm/bin/npm-cli.js");

function diagnosticTail(value) {
  let output = String(value || "");
  for (const [path, replacement] of [
    [source, "<harness-source>"],
    [destination, "<harness-candidate>"],
    [desktop, "<desktop-harness>"],
    [homedir(), "<home>"]
  ].sort((left, right) => right[0].length - left[0].length)) {
    if (path) output = output.replaceAll(path, replacement);
  }
  output = output
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+@/giu, "$1<redacted>@")
    .replace(/\b(authorization|password|secret|token)(\s*[:=]\s*)\S+/giu, "$1$2<redacted>");
  return output.trim().split(/\r?\n/u).filter(Boolean).slice(-16).join("\n").slice(-4000);
}

function runPackageManager(cli, args, cwd, name) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, CI: "true", PNPM_CONFIG_PM_ON_FAIL: "ignore" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = diagnosticTail(`${result.stdout || ""}\n${result.stderr || ""}`);
    throw new Error(`Harness ${name} preparation failed${detail ? `:\n${detail}` : ` with exit code ${String(result.status)}`}`);
  }
}
function runPnpm(args, cwd = source) {
  runPackageManager(pnpm, ["--pm-on-fail=ignore", ...args], cwd, "pnpm");
}
function runNpm(args, cwd = source) {
  runPackageManager(npm, args, cwd, "npm");
}

try {
  await Promise.all([stat(pnpm), stat(npm)]);
  runPnpm(["install", "--frozen-lockfile"]);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (!manifest.scripts?.["build:official"]) throw new Error("Harness repository does not provide build:official");
  runPnpm(["run", "build:official"]);
  const workspace = await findWorkspacePackages(source);
  const cli = findCliPackage(workspace);
  await stat(join(cli.directory, cli.entry));
  await deployHarnessClosure(source, workspace, cli, destination, runPnpm, {
    desktopDeployment: desktop,
    desktopRoots: DESKTOP_EXTENSION_ROOTS,
    runHarnessNpm: runNpm
  });
  await mergeDesktopClosure(desktop, destination, DESKTOP_EXTENSION_ROOTS);
  const desktopLock = JSON.parse(await readFile(join(desktop, "harness-lock.json"), "utf8"));
  await applyDesktopCompatibilityPatches(
    [join(destination, "node_modules")],
    desktopLock.desktopPatches,
    join(desktop, "toolchain", "desktop-patches")
  );
  const entry = join("node_modules", ...cli.manifest.name.split("/"), cli.entry).split(sep).join("/");
  await stat(join(destination, entry));
  await writeFile(resultFile, `${JSON.stringify({ version: cli.manifest.version, entry })}\n`);
} catch (error) {
  const message = diagnosticTail(error instanceof Error ? error.message : error) || "Harness repository preparation failed";
  await writeFile(resultFile, `${JSON.stringify({ error: message })}\n`);
  throw new Error("Harness repository preparation failed");
}
