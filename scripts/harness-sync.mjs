import { createHash } from "node:crypto";
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import process from "node:process";

import {
  deployHarnessClosure,
  findCliPackage,
  findWorkspacePackages,
  mergeDesktopPackages,
  pruneNativeBuildIntermediates,
  sanitizeBuildPaths
} from "./lib/harness-deployment.mjs";
import { loadBuildConfig } from "./lib/build-config.mjs";
import { artifactForbiddenRoots } from "./lib/artifact-scan.mjs";
import { selectLatestHarnessTag } from "./lib/harness-ref.mjs";
import { findInstalledPackages } from "./lib/installed-packages.mjs";
import { applyPackagePatch } from "./lib/package-patch.mjs";
import { applyPackageTextReplacements } from "./lib/package-text-replacement.mjs";
import { assertPinnedHarnessSource } from "./lib/harness-source-pin.mjs";

const root = resolve(import.meta.dirname, "..");
const harnessRoot = join(root, "harness");
const generatedRoot = join(root, "target", "generated");
const cacheRoot = join(root, "target", "harness-sync");
const toolchain = JSON.parse(await readFile(join(harnessRoot, "toolchain-lock.json"), "utf8"));

const args = process.argv.slice(2);
const check = args.includes("--check");
const localIndex = args.indexOf("--local");
const allowed = new Set(["--check", "--local"]);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (!allowed.has(argument) && index !== localIndex + 1) throw new Error(`unsupported harness:sync argument: ${argument}`);
}
const localPath = localIndex >= 0 ? args[localIndex + 1] : null;
if (localIndex >= 0 && (!localPath || !isAbsolute(localPath))) {
  throw new Error("harness:sync --local requires an absolute Harness repository path");
}

function run(command, commandArgs, cwd, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: options.capture ? 16 * 1024 * 1024 : undefined,
    shell: false,
    env: { ...process.env, ...options.env }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with code ${String(result.status)}${options.capture ? `: ${result.stderr || result.stdout}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function runGit(commandArgs, cwd, options = {}) {
  const platformArgs = process.platform === "win32" ? ["-c", "core.longPaths=true"] : [];
  return run("git", [...platformArgs, ...commandArgs], cwd, { capture: options.capture ?? true });
}

let pinnedToolEnvironment;

async function preparePinnedPnpm() {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable is unavailable; run harness:sync through pnpm");
  const binRoot = join(cacheRoot, "bin");
  const wrapper = join(binRoot, "pnpm-wrapper.mjs");
  await mkdir(binRoot, { recursive: true });
  await writeFile(wrapper, [
    'import { spawnSync } from "node:child_process";',
    'import process from "node:process";',
    `const result = spawnSync(process.execPath, [${JSON.stringify(pnpmCli)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });`,
    'if (result.error) throw result.error;',
    'process.exit(result.status ?? 1);',
    ""
  ].join("\n"));
  const unixLauncher = join(binRoot, "pnpm");
  await writeFile(unixLauncher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)} "$@"\n`);
  await chmod(unixLauncher, 0o755);
  await writeFile(join(binRoot, "pnpm.cmd"), `@echo off\r\n"${process.execPath}" "${wrapper}" %*\r\n`);
  return {
    ...process.env,
    CI: "true",
    PNPM_CONFIG_PM_ON_FAIL: "ignore",
    PATH: `${binRoot}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`
  };
}

function runPnpm(commandArgs, cwd) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !pinnedToolEnvironment) throw new Error("pinned pnpm environment has not been initialized");
  run(process.execPath, [pnpmCli, ...commandArgs], cwd, { env: pinnedToolEnvironment });
}

function runHarnessPnpm(commandArgs, cwd) {
  // The immutable Harness checkout can declare an older package-manager
  // preference. Desktop builds still use the audited version in our toolchain
  // lock; this only disables pnpm's project-version refusal in the temporary
  // checkout and does not modify upstream source or its dependency lock.
  runPnpm(["--pm-on-fail=ignore", ...commandArgs], cwd);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readPackageVersion(nodeModules, packageName) {
  const manifest = JSON.parse(await readFile(join(packagePath(nodeModules, packageName), "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`package version is missing: ${packageName}`);
  }
  return manifest.version;
}

function packagePath(nodeModules, packageName) {
  return join(nodeModules, ...packageName.split("/"));
}

async function hashTree(directory) {
  const hash = createHash("sha256");
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = relative(directory, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        hash.update(`L\0${name}\0${await readlink(path)}\0`);
      } else if (info.isDirectory()) {
        hash.update(`D\0${name}\0`);
        await visit(path);
      } else if (info.isFile()) {
        hash.update(`F\0${name}\0${info.mode & 0o777}\0`);
        hash.update(await readFile(path));
      }
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

function buildPathReplacements(sourceRoot) {
  // Every root the release artifact scan rejects must also be rewritten here, or a
  // binary that embeds one ships unmodified and fails the scan instead. Keeping the
  // two lists independent is what kept the Windows job failing: after the build moved
  // to the short path C:\d, only that root was replaced, while GITHUB_WORKSPACE
  // (D:\a\...) stayed forbidden and unreplaced, and MSVC embeds the real build
  // directory in the .node debug directory.
  const paths = [
    [sourceRoot, "/deepseek-harness"],
    [root, "/deepseek-desktop"],
    // artifactForbiddenRoots normalizes to forward slashes, but a Windows binary
    // embeds its build directory with backslashes, so both spellings must be
    // replaced. The scan normalizes file content before comparing, which is why it
    // catches a path the forward-slash-only replacement never matched.
    ...artifactForbiddenRoots(root).flatMap(value => [
      [value, "/deepseek-desktop"],
      [value.replaceAll("/", "\\"), "/deepseek-desktop"]
    ]),
    [homedir(), "/user-home"],
    [process.env.HOME, "/user-home"],
    [process.env.USERPROFILE, "/user-home"]
  ].filter(([from]) => typeof from === "string" && from.length > 0);
  const normalized = paths.flatMap(([from, to]) => {
    const slashPath = from.replaceAll("\\", "/");
    return slashPath === from ? [[from, to]] : [[from, to], [slashPath, to]];
  });
  return [...new Map(normalized.map(item => [item[0], item])).values()]
    .sort((left, right) => right[0].length - left[0].length);
}

async function prepareRemote(repository, ref) {
  const mirror = join(cacheRoot, "repository.git");
  await mkdir(cacheRoot, { recursive: true });
  try {
    await stat(join(mirror, "HEAD"));
    runGit(["remote", "set-url", "origin", repository], mirror);
  } catch {
    await rm(mirror, { recursive: true, force: true });
    runGit(["clone", "--mirror", repository, mirror], root);
  }
  let fetchError = null;
  try {
    runGit(["fetch", "--prune", "--tags", "origin"], mirror);
  } catch (error) {
    fetchError = error;
  }
  const requestedRef = ref.trim() || null;
  const resolvedRef = requestedRef || selectLatestHarnessTag(
    runGit(["tag", "--list"], mirror).split("\n").filter(Boolean)
  );
  let commit;
  const candidates = [`refs/tags/${resolvedRef}^{commit}`, `refs/remotes/origin/${resolvedRef}^{commit}`, `${resolvedRef}^{commit}`];
  for (const candidate of candidates) {
    try {
      commit = runGit(["rev-parse", "--verify", candidate], mirror);
      break;
    } catch {}
  }
  if (!commit || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`HARNESS_REF could not be resolved: ${resolvedRef}`);
  const tag = runGit(["tag", "--points-at", commit], mirror).split("\n").find(value => value === resolvedRef) || null;
  const kind = tag ? "tag" : /^[0-9a-f]{40}$/u.test(resolvedRef) ? "commit" : "branch";
  if (fetchError && kind === "branch") throw fetchError;
  if (fetchError) {
    console.warn(`Harness fetch failed; using cached immutable ${kind} ${resolvedRef} (${commit.slice(0, 12)}).`);
  }
  const checkout = join(cacheRoot, "source", commit);
  let current = null;
  try { current = runGit(["rev-parse", "HEAD"], checkout); } catch {}
  const recreateCheckout = process.platform === "win32" || current !== commit;
  if (recreateCheckout) {
    await rm(checkout, { recursive: true, force: true });
    await mkdir(dirname(checkout), { recursive: true });
    // A local clone hardlinks .git/objects by default, so git aborts with
    // "hardlink different from source" whenever the mirror's background
    // maintenance rewrites a commit-graph while the clone is running.
    runGit(["clone", "--no-hardlinks", "--no-checkout", mirror, checkout], root);
    runGit(["checkout", "--detach", commit], checkout);
  }
  if (!recreateCheckout) {
    runGit(["reset", "--hard", commit], checkout);
    runGit(["clean", "-ffdx", "-q"], checkout, { capture: false });
  }
  return { sourceRoot: checkout, repository, requestedRef, ref: resolvedRef, commit, dirty: false, kind, mode: "remote" };
}

async function prepareLocal(path, ref) {
  const sourceRoot = await realpath(resolve(path));
  const commit = runGit(["rev-parse", "HEAD"], sourceRoot);
  const dirty = runGit(["status", "--porcelain"], sourceRoot).length > 0;
  const repository = (() => {
    try { return runGit(["remote", "get-url", "origin"], sourceRoot); } catch { return sourceRoot; }
  })();
  return { sourceRoot, repository, requestedRef: ref.trim() || null, ref: ref.trim() || commit, commit, dirty, kind: "local", mode: "local" };
}

async function applyDesktopPatches(moduleRoots) {
  const applied = [];
  for (const patch of toolchain.desktopPatches) {
    const directories = await findInstalledPackages(moduleRoots, patch.packageName);
    if (directories.length === 0) throw new Error(`Desktop patch target is missing: ${patch.packageName}`);
    for (const directory of directories) {
      if (patch.operation === "add-dependency") {
        const manifestPath = join(directory, "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.dependencies = { ...manifest.dependencies, [patch.dependency]: patch.version };
        await writeJson(manifestPath, manifest);
        continue;
      }
      if (patch.operation === "replace-text") {
        applyPackageTextReplacements(directory, patch.moduleFile, patch.replacements);
        continue;
      }
      if (!patch.file) throw new Error(`Desktop patch file is missing for ${patch.packageName}:${patch.id}`);
      const patchFile = join(harnessRoot, "patches", patch.file);
      applyPackagePatch(directory, patchFile);
    }
    applied.push(`${patch.packageName}:${patch.id}:${directories.length}`);
  }
  return applied;
}

const config = await loadBuildConfig(root);
await mkdir(cacheRoot, { recursive: true });
pinnedToolEnvironment = await preparePinnedPnpm();
const releaseChannel = config.release.channel;
const releaseBuild = releaseChannel === "community" || releaseChannel === "stable";
const source = localPath
  ? await prepareLocal(localPath, config.harness.ref)
  : await prepareRemote(config.harness.repository, config.harness.ref);
if (releaseBuild && (source.mode !== "remote" || source.dirty || source.kind === "branch")) {
  throw new Error("release builds require a clean remote Harness tag or immutable commit");
}
if (releaseBuild) assertPinnedHarnessSource(source, toolchain.harnessSource);

const workRoot = check
  ? await mkdtemp(join(tmpdir(), "deepseek-desktop-harness-sync-"))
  : join(generatedRoot, "harness");
try {
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  runHarnessPnpm(["install", "--frozen-lockfile"], source.sourceRoot);
  const sourcePackage = JSON.parse(await readFile(join(source.sourceRoot, "package.json"), "utf8"));
  if (!sourcePackage.scripts?.["build:official"]) throw new Error("Harness repository does not provide build:official");
  runHarnessPnpm(["build:official"], source.sourceRoot);
  const workspacePackages = await findWorkspacePackages(source.sourceRoot);
  const cli = findCliPackage(workspacePackages);
  await stat(join(cli.directory, cli.entry));

  runPnpm(["install", "--frozen-lockfile"], harnessRoot);
  const desktopDeployment = join(workRoot, "desktop-deployment");
  const harnessDeployment = join(workRoot, "harness-deployment");
  const prepared = join(workRoot, "prepared");
  await rm(desktopDeployment, { recursive: true, force: true });
  await rm(harnessDeployment, { recursive: true, force: true });
  await rm(prepared, { recursive: true, force: true });
  runPnpm([
    "--filter", "deepseek-desktop-harness", "deploy", "--prod", "--legacy",
    "--config.node-linker=hoisted", desktopDeployment
  ], harnessRoot);
  const restoredHarnessPackages = await deployHarnessClosure(
    source.sourceRoot,
    workspacePackages,
    cli,
    harnessDeployment,
    runHarnessPnpm
  );
  const mergedDesktopPackages = await mergeDesktopPackages(desktopDeployment, harnessDeployment);
  await rm(desktopDeployment, { recursive: true, force: true });
  await rename(harnessDeployment, prepared);

  const finalModules = join(prepared, "node_modules");
  const patches = await applyDesktopPatches([finalModules]);
  const prunedBuildIntermediates = await pruneNativeBuildIntermediates(prepared);
  const sanitizedPaths = await sanitizeBuildPaths(prepared, buildPathReplacements(source.sourceRoot));
  const entry = join("node_modules", ...cli.manifest.name.split("/"), cli.entry).split(sep).join("/");
  await stat(join(prepared, entry));
  const sourceDateEpoch = Number.parseInt(runGit(["show", "-s", "--format=%ct", source.commit], source.sourceRoot), 10);
  const bundleVersion = await readPackageVersion(finalModules, "deepseek-desktop-bundle");
  const credentialVaultVersion = await readPackageVersion(finalModules, "deepseek-desktop-credentials-vault");
  const harnessSha256 = await hashTree(prepared);
  const lock = {
    schemaVersion: 3,
    sourceDateEpoch,
    desktopVersion: config.version,
    release: {
      channel: releaseChannel,
      sourcePinned: releaseBuild
    },
    harness: {
      version: cli.manifest.version,
      ref: source.ref,
      commit: source.commit,
      sourceUrl: source.repository,
      sourceMode: source.mode,
      sourceKind: source.kind,
      sourceDirty: source.dirty,
      sanitizedPaths,
      prunedBuildIntermediates,
      restoredWorkspacePackages: restoredHarnessPackages,
      mergedDesktopPackages,
      packageName: cli.manifest.name,
      entry,
      sha256: harnessSha256,
      license: typeof cli.manifest.license === "string" ? cli.manifest.license : "NOASSERTION"
    },
    node: toolchain.node,
    toolchain: toolchain.toolchain,
    bundledPackages: toolchain.bundledPackages,
    nativeAssets: toolchain.nativeAssets,
    targets: toolchain.targets,
    patches: [
      `deepseek-desktop-bundle@${bundleVersion}`,
      `deepseek-desktop-credentials-vault@${credentialVaultVersion}`,
      ...patches
    ]
  };
  await writeJson(join(workRoot, "harness-lock.json"), lock);
  if (!check) {
    await writeJson(join(generatedRoot, "harness-lock.json"), lock);
    await writeJson(join(generatedRoot, "harness-source.json"), {
      schemaVersion: 1,
      repository: source.repository,
      requestedRef: source.requestedRef,
      resolvedRef: source.ref,
      resolvedCommit: source.commit,
      sourceMode: source.mode,
      sourceKind: source.kind,
      dirty: source.dirty,
      packageName: cli.manifest.name,
      entry,
      harnessSha256
    });
  }
  console.log(`${check ? "validated" : "synchronized"} Harness ${cli.manifest.version} (${source.commit.slice(0, 12)})`);
} finally {
  if (check) await rm(workRoot, { recursive: true, force: true });
}
