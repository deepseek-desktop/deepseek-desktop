import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import process from "node:process";

function packagePath(nodeModules, name) { return join(nodeModules, ...name.split("/")); }

function replaceBuffer(input, search, replacement, preserveSize) {
  if (search.length === 0 || !input.includes(search)) return { bytes: input, replacements: 0 };
  if (preserveSize && replacement.length > search.length) {
    throw new Error("binary build path replacement cannot be longer than its source");
  }
  const effectiveReplacement = preserveSize
    ? Buffer.concat([replacement, Buffer.alloc(search.length - replacement.length)])
    : replacement;
  const chunks = [];
  let offset = 0;
  let replacements = 0;
  for (;;) {
    const index = input.indexOf(search, offset);
    if (index < 0) break;
    chunks.push(input.subarray(offset, index), effectiveReplacement);
    offset = index + search.length;
    replacements += 1;
  }
  chunks.push(input.subarray(offset));
  return { bytes: Buffer.concat(chunks), replacements };
}

function isMachO(bytes) {
  if (bytes.length < 4) return false;
  return new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
    .has(bytes.readUInt32BE(0));
}

function signMachO(path) {
  const result = spawnSync("codesign", ["--force", "--sign", "-", path], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign failed for sanitized Mach-O ${path}: ${result.stderr || result.stdout}`);
  }
}

export async function sanitizeBuildPaths(directory, replacements) {
  let rewrittenFiles = 0;
  let replacementCount = 0;
  let resignedFiles = 0;
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes = await readFile(path);
      const binary = bytes.includes(0);
      const machO = binary && process.platform === "darwin" && isMachO(bytes);
      let changed = false;
      for (const [from, to] of replacements) {
        const result = replaceBuffer(bytes, Buffer.from(from), Buffer.from(to), binary);
        bytes = result.bytes;
        if (result.replacements > 0) {
          changed = true;
          replacementCount += result.replacements;
        }
      }
      if (changed) {
        await writeFile(path, bytes);
        if (machO) {
          signMachO(path);
          resignedFiles += 1;
        }
        rewrittenFiles += 1;
      }
    }
  }
  await visit(directory);
  return { rewrittenFiles, replacementCount, resignedFiles };
}

export async function findWorkspacePackages(sourceRoot) {
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

export function findCliPackage(workspacePackages) {
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

function harnessDependencies(manifest) {
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
      for (const dependency of harnessDependencies(manifest)) dependencies.add(dependency);
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

export async function mergeDesktopPackages(desktopDeployment, harnessDeployment) {
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

export async function mergeDesktopClosure(desktopDeployment, harnessDeployment, roots) {
  const sourceModules = join(desktopDeployment, "node_modules");
  const destinationModules = join(harnessDeployment, "node_modules");
  const visited = new Set();
  const copied = [];
  async function visit(name, required = true) {
    if (visited.has(name)) return;
    const destination = packagePath(destinationModules, name);
    if (!roots.includes(name) && await pathExists(destination)) return;
    const source = packagePath(sourceModules, name);
    if (!await pathExists(join(source, "package.json"))) {
      if (required) throw new Error(`Desktop dependency is missing: ${name}`);
      return;
    }
    visited.add(name);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const peer of manifest.dsh?.desktop?.harnessPackages ?? []) {
      if (!await pathExists(join(packagePath(destinationModules, peer), "package.json"))) {
        throw new Error(`Candidate Harness extension dependency is missing: ${peer}`);
      }
    }
    // Peer services must come from the new Harness, never an older bundled core.
    for (const peer of Object.keys(manifest.peerDependencies || {})) {
      if (!await pathExists(packagePath(destinationModules, peer)) && !manifest.peerDependenciesMeta?.[peer]?.optional) {
        throw new Error(`Candidate Harness peer is missing: ${peer}`);
      }
    }
    await rm(destination, { recursive: true, force: true });
    await copyPackage(source, destination);
    if (manifest.dsh?.client) {
      const client = manifest.exports?.["./client"];
      const entry = typeof client === "string" ? client : client?.default;
      if (typeof entry !== "string" || !entry.startsWith("./") || entry.includes("..", 2)
        || !await pathExists(join(destination, entry))) {
        throw new Error(`Desktop client entry is missing: ${name}`);
      }
      // Only Desktop-owned extensions declare these as hard requirements;
      // third-party manifests may also name optional, legacy client services.
      for (const dependency of manifest.dsh.desktop ? manifest.dsh.client.inject ?? [] : []) {
        const peer = packagePath(destinationModules, dependency);
        if (!await pathExists(join(peer, "package.json"))) {
          throw new Error(`Candidate Harness client dependency is missing: ${dependency}`);
        }
      }
    }
    copied.push(name);
    for (const dependency of Object.keys(manifest.dependencies || {})) await visit(dependency);
    for (const dependency of Object.keys(manifest.optionalDependencies || {})) await visit(dependency, false);
  }
  for (const name of roots) await visit(name);
  return copied;
}

export async function deployHarnessClosure(sourceRoot, workspacePackages, cli, destination, runHarnessPnpm) {
  const manifestPath = join(sourceRoot, "python", "sdk-runtime", "package.json");
  const lockPath = join(sourceRoot, "pnpm-lock.yaml");
  const originalManifest = await readFile(manifestPath);
  const originalLock = await readFile(lockPath);
  try {
    const manifest = JSON.parse(originalManifest.toString("utf8"));
    if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
      throw new Error("Python SDK deployment manifest must declare a package name");
    }
    manifest.dependencies = { ...manifest.dependencies, [cli.manifest.name]: "workspace:^" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    runHarnessPnpm(["install", "--lockfile-only", "--ignore-scripts", "--config.auto-install-peers=false"], sourceRoot);
    runHarnessPnpm(["install", "--frozen-lockfile", "--ignore-scripts", "--config.auto-install-peers=false"], sourceRoot);
    await rm(destination, { recursive: true, force: true });
    runHarnessPnpm([
      "--filter", manifest.name, "deploy", "--legacy", "--prod",
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
