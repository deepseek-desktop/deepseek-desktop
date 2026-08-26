import { createHash } from "node:crypto";
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { loadBuildConfig } from "./lib/build-config.mjs";
import { selectLatestHarnessTag } from "./lib/harness-ref.mjs";
import { findInstalledPackages } from "./lib/installed-packages.mjs";
import { applyPackagePatch } from "./lib/package-patch.mjs";

const root = resolve(import.meta.dirname, "..");
const runtimeRoot = join(root, "runtime");
const generatedRoot = join(root, "target", "generated");
const cacheRoot = join(root, "target", "runtime-sync");
const toolchain = JSON.parse(await readFile(join(runtimeRoot, "toolchain-lock.json"), "utf8"));

const args = process.argv.slice(2);
const check = args.includes("--check");
const localIndex = args.indexOf("--local");
const allowed = new Set(["--check", "--local"]);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (!allowed.has(argument) && index !== localIndex + 1) throw new Error(`unsupported runtime:sync argument: ${argument}`);
}
const localPath = localIndex >= 0 ? args[localIndex + 1] : null;
if (localIndex >= 0 && (!localPath || !isAbsolute(localPath))) {
  throw new Error("runtime:sync --local requires an absolute Harness repository path");
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
  if (!pnpmCli) throw new Error("pnpm executable is unavailable; run runtime:sync through pnpm");
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
    PATH: `${binRoot}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`
  };
}

function runPnpm(commandArgs, cwd) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !pinnedToolEnvironment) throw new Error("pinned pnpm environment has not been initialized");
  run(process.execPath, [pnpmCli, ...commandArgs], cwd, { env: pinnedToolEnvironment });
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

async function findWorkspacePackages(sourceRoot) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target" || entry.name === "dist") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(path, "utf8"));
        if (manifest.name) found.push({ directory, manifest });
      }
    }
  }
  await visit(sourceRoot);
  return new Map(found.map(item => [item.manifest.name, item]));
}

function findCliPackage(workspacePackages) {
  const candidates = [];
  for (const item of workspacePackages.values()) {
    const dshEntry = typeof item.manifest.bin === "object" && typeof item.manifest.bin?.dsh === "string"
      ? item.manifest.bin.dsh
      : typeof item.manifest.bin === "string" && basename(item.manifest.bin) === "dsh"
        ? item.manifest.bin
        : null;
    if (dshEntry) candidates.push({ ...item, entry: dshEntry.replace(/^\.\//u, "") });
  }
  if (candidates.length !== 1) {
    throw new Error(`Harness must expose exactly one workspace package with bin.dsh, found ${candidates.map(item => item.manifest.name).join(", ") || "none"}`);
  }
  return candidates[0];
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyPackage(source, destination) {
  const nestedNodeModules = join(source, "node_modules");
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`)
  });
}

function runtimeDependencies(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
    ...Object.keys(manifest.peerDependencies || {})
  ]);
}

async function restoreWorkspaceClosure(deploymentRoot, workspacePackages) {
  const nodeModules = join(deploymentRoot, "node_modules");
  const restored = [];
  let changed = true;
  while (changed) {
    changed = false;
    const manifests = [join(deploymentRoot, "package.json")];
    for (const item of await packageDirectories(nodeModules)) {
      const manifest = join(item.path, "package.json");
      if (await pathExists(manifest)) manifests.push(manifest);
    }
    const dependencies = new Set();
    for (const manifestPath of manifests) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      for (const dependency of runtimeDependencies(manifest)) dependencies.add(dependency);
    }
    for (const dependency of [...dependencies].sort()) {
      const workspacePackage = workspacePackages.get(dependency);
      if (!workspacePackage) continue;
      const destination = packagePath(nodeModules, dependency);
      if (await pathExists(destination)) continue;
      await copyPackage(workspacePackage.directory, destination);
      restored.push(dependency);
      changed = true;
    }
  }
  return restored;
}

async function findSymlink(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return path;
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path);
      if (nested) return nested;
    }
  }
  return null;
}

async function materializePackageLinks(nodeModules) {
  let link = await findSymlink(nodeModules);
  while (link) {
    const segments = relative(nodeModules, link).split(sep);
    const binIndex = segments.lastIndexOf(".bin");
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true });
    } else {
      const source = await realpath(link);
      await rm(link, { recursive: true, force: true });
      await copyPackage(source, link);
    }
    link = await findSymlink(nodeModules);
  }
}

async function packageDirectories(nodeModules) {
  const packages = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".pnpm" || entry.name === ".modules.yaml") continue;
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) {
          packages.push({ name: `${entry.name}/${child.name}`, path: join(path, child.name) });
        }
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      packages.push({ name: entry.name, path });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function mergeDesktopPackages(desktopDeployment, harnessDeployment) {
  const sourceModules = join(desktopDeployment, "node_modules");
  const destinationModules = join(harnessDeployment, "node_modules");
  const merged = [];
  for (const item of await packageDirectories(sourceModules)) {
    const destination = packagePath(destinationModules, item.name);
    if (await pathExists(destination)) continue;
    await copyPackage(item.path, destination);
    merged.push(item.name);
  }
  return merged;
}

async function deployHarnessClosure(sourceRoot, workspacePackages, cli, destination) {
  const manifestPath = join(sourceRoot, "python", "sdk-runtime", "package.json");
  const lockPath = join(sourceRoot, "pnpm-lock.yaml");
  const originalManifest = await readFile(manifestPath);
  const originalLock = await readFile(lockPath);
  try {
    const manifest = JSON.parse(originalManifest.toString("utf8"));
    manifest.dependencies = { ...manifest.dependencies, [cli.manifest.name]: "workspace:^" };
    await writeJson(manifestPath, manifest);
    runPnpm(["install", "--lockfile-only", "--ignore-scripts", "--config.auto-install-peers=false"], sourceRoot);
    runPnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--config.auto-install-peers=false"], sourceRoot);
    await rm(destination, { recursive: true, force: true });
    runPnpm([
      "--filter", "dsh-jsonrpc-agent-pkg", "deploy", "--legacy", "--prod",
      "--config.node-linker=hoisted", "--config.auto-install-peers=false",
      "--config.link-workspace-packages=true", destination
    ], sourceRoot);
    const restored = await restoreWorkspaceClosure(destination, workspacePackages);
    await materializePackageLinks(join(destination, "node_modules"));
    return restored;
  } finally {
    await writeFile(manifestPath, originalManifest);
    await writeFile(lockPath, originalLock);
  }
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

function replaceBuffer(input, search, replacement) {
  if (search.length === 0 || !input.includes(search)) return { bytes: input, replacements: 0 };
  const chunks = [];
  let offset = 0;
  let replacements = 0;
  for (;;) {
    const index = input.indexOf(search, offset);
    if (index < 0) break;
    chunks.push(input.subarray(offset, index), replacement);
    offset = index + search.length;
    replacements += 1;
  }
  chunks.push(input.subarray(offset));
  return { bytes: Buffer.concat(chunks), replacements };
}

async function sanitizeBuildPaths(directory, replacements) {
  let rewrittenFiles = 0;
  let replacementCount = 0;
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes = await readFile(path);
      let changed = false;
      for (const [from, to] of replacements) {
        const result = replaceBuffer(bytes, Buffer.from(from), Buffer.from(to));
        bytes = result.bytes;
        if (result.replacements > 0) {
          changed = true;
          replacementCount += result.replacements;
        }
      }
      if (changed) {
        await writeFile(path, bytes);
        rewrittenFiles += 1;
      }
    }
  }
  await visit(directory);
  return { rewrittenFiles, replacementCount };
}

function buildPathReplacements(sourceRoot) {
  const paths = [
    [sourceRoot, "/deepseek-harness"],
    [root, "/deepseek-desktop"]
  ];
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
    runGit(["clone", "--no-checkout", mirror, checkout], root);
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
      if (!patch.file) throw new Error(`Desktop patch file is missing for ${patch.packageName}:${patch.id}`);
      const patchFile = join(runtimeRoot, "patches", patch.file);
      applyPackagePatch(directory, patchFile);
    }
    applied.push(`${patch.packageName}:${patch.id}:${directories.length}`);
  }
  return applied;
}

const config = await loadBuildConfig(root);
await mkdir(cacheRoot, { recursive: true });
pinnedToolEnvironment = await preparePinnedPnpm();
const releaseChannel = process.env.RELEASE_CHANNEL?.trim() || "local";
const releaseBuild = releaseChannel === "community" || releaseChannel === "stable";
const source = localPath
  ? await prepareLocal(localPath, config.harness.ref)
  : await prepareRemote(config.harness.repository, config.harness.ref);
if (releaseBuild && (source.mode !== "remote" || source.dirty || source.kind === "branch")) {
  throw new Error("release builds require a clean remote Harness tag or immutable commit");
}

const workRoot = check
  ? await mkdtemp(join(tmpdir(), "deepseek-desktop-runtime-sync-"))
  : join(generatedRoot, "runtime");
try {
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  runPnpm(["install", "--frozen-lockfile"], source.sourceRoot);
  const sourcePackage = JSON.parse(await readFile(join(source.sourceRoot, "package.json"), "utf8"));
  if (!sourcePackage.scripts?.["build:official"]) throw new Error("Harness repository does not provide build:official");
  runPnpm(["build:official"], source.sourceRoot);
  const workspacePackages = await findWorkspacePackages(source.sourceRoot);
  const cli = findCliPackage(workspacePackages);
  await stat(join(cli.directory, cli.entry));

  runPnpm(["install", "--frozen-lockfile"], runtimeRoot);
  const desktopDeployment = join(workRoot, "desktop-deployment");
  const harnessDeployment = join(workRoot, "harness-deployment");
  const prepared = join(workRoot, "prepared");
  await rm(desktopDeployment, { recursive: true, force: true });
  await rm(harnessDeployment, { recursive: true, force: true });
  await rm(prepared, { recursive: true, force: true });
  runPnpm([
    "--filter", "deepseek-desktop-runtime", "deploy", "--prod", "--legacy",
    "--config.node-linker=hoisted", desktopDeployment
  ], runtimeRoot);
  const restoredHarnessPackages = await deployHarnessClosure(
    source.sourceRoot,
    workspacePackages,
    cli,
    harnessDeployment
  );
  const mergedDesktopPackages = await mergeDesktopPackages(desktopDeployment, harnessDeployment);
  await rm(desktopDeployment, { recursive: true, force: true });
  await rename(harnessDeployment, prepared);

  const finalModules = join(prepared, "node_modules");
  const patches = await applyDesktopPatches([finalModules]);
  const sanitizedPaths = await sanitizeBuildPaths(prepared, buildPathReplacements(source.sourceRoot));
  const entry = join("node_modules", ...cli.manifest.name.split("/"), cli.entry).split(sep).join("/");
  await stat(join(prepared, entry));
  const sourceDateEpoch = Number.parseInt(runGit(["show", "-s", "--format=%ct", source.commit], source.sourceRoot), 10);
  const bundleVersion = await readPackageVersion(finalModules, "deepseek-desktop-bundle");
  const credentialVaultVersion = await readPackageVersion(finalModules, "deepseek-desktop-credentials-vault");
  const runtimeSha256 = await hashTree(prepared);
  const lock = {
    schemaVersion: 2,
    sourceDateEpoch,
    desktopVersion: config.version,
    runtime: {
      version: cli.manifest.version,
      ref: source.ref,
      commit: source.commit,
      sourceUrl: source.repository,
      sourceMode: source.mode,
      sourceKind: source.kind,
      sourceDirty: source.dirty,
      sanitizedPaths,
      restoredWorkspacePackages: restoredHarnessPackages,
      mergedDesktopPackages,
      packageName: cli.manifest.name,
      entry,
      sha256: runtimeSha256,
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
  await writeJson(join(workRoot, "runtime-lock.json"), lock);
  if (!check) {
    await writeJson(join(generatedRoot, "runtime-lock.json"), lock);
    await writeJson(join(generatedRoot, "runtime-source.json"), {
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
      runtimeSha256
    });
  }
  console.log(`${check ? "validated" : "synchronized"} Harness Runtime ${cli.manifest.version} (${source.commit.slice(0, 12)})`);
} finally {
  if (check) await rm(workRoot, { recursive: true, force: true });
}
