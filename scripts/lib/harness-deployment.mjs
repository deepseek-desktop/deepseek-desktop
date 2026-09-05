import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

function packagePath(nodeModules, name) { return join(nodeModules, ...name.split("/")); }

export async function patchBrowserJsonIntrinsics(deploymentRoot) {
  const before = 'Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`';
  const after = 'Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === "Array" ? Array : Object)';
  const changed = [];
  // These browser entry points inline util-values; changing only its package is insufficient.
  for (const [name, entry] of [
    ["dsh-util-values", "lib/index.js"],
    ["dsh-client-connection", "lib/client.js"],
    ["dsh-api-session-controller", "lib/client.js"],
    ["dsh-client-ui-chat", "lib/client.js"],
    ["dsh-client-ui-trajectory", "lib/client.js"]
  ]) {
    const file = join(deploymentRoot, "node_modules", "@deepseek-ai", name, entry);
    let source;
    try { source = await readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!source.includes(before)) continue;
    await writeFile(file, source.replaceAll(before, after));
    changed.push(`${name}/${entry}`);
  }
  return changed;
}

function replaceBuffer(input, search, replacement, preserveSize, unitBytes = 1) {
  if (search.length === 0 || !input.includes(search)) return { bytes: input, replacements: 0 };
  const boundedReplacement = preserveSize && replacement.length > search.length
    ? replacement.subarray(0, Math.max(0, search.length - unitBytes))
    : replacement;
  const effectiveReplacement = preserveSize
    ? Buffer.concat([boundedReplacement, Buffer.alloc(search.length - boundedReplacement.length)])
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

// A node-gyp build directory keeps the entire build system next to the loadable
// addon: config.gypi, the generated Makefile/vcxproj, dependency records under
// .deps, and link intermediates such as MSVC .iobj. All of them embed absolute
// build paths, none of them are read at runtime (the loader only requires the
// .node), and the release artifact scan rejects any file carrying the build root.
// That is what broke the Windows job for v1.0.32 and v1.0.33. Keep the addon, drop
// the rest of the build tree.
//
// Only directories that are actually node-gyp output are touched: plenty of
// packages ship hand-written sources under a directory called "build".
async function isNodeGypBuildDirectory(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  if (entries.some(entry => entry.isFile() && entry.name === "config.gypi")) return true;
  for (const configuration of ["Release", "Debug"]) {
    const candidate = entries.find(entry => entry.isDirectory() && entry.name === configuration);
    if (!candidate) continue;
    const inner = await readdir(join(path, configuration), { withFileTypes: true }).catch(() => []);
    if (inner.some(entry => entry.isFile() && entry.name.endsWith(".node"))) return true;
  }
  return false;
}

async function pruneBuildDirectory(path, relativePath, removed) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    const entryRelative = `${relativePath}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "Release" || entry.name === "Debug") {
        for (const inner of await readdir(entryPath, { withFileTypes: true })) {
          if (inner.isFile() && inner.name.endsWith(".node")) continue;
          await rm(join(entryPath, inner.name), { recursive: true, force: true });
          removed.push(`${entryRelative}/${inner.name}${inner.isDirectory() ? "/" : ""}`);
        }
        continue;
      }
      await rm(entryPath, { recursive: true, force: true });
      removed.push(`${entryRelative}/`);
      continue;
    }
    await rm(entryPath, { force: true });
    removed.push(entryRelative);
  }
}

export async function pruneNativeBuildIntermediates(directory) {
  const removed = [];
  async function visit(current, relativePath) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.name === "build" && (await isNodeGypBuildDirectory(path))) {
        await pruneBuildDirectory(path, entryRelative, removed);
        continue;
      }
      await visit(path, entryRelative);
    }
  }
  await visit(directory, "");
  return removed.sort();
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
        // Match both encodings inspected by the artifact scanner, including PE strings.
        for (const encoding of ["utf8", "utf16le"]) {
          const result = replaceBuffer(bytes, Buffer.from(from, encoding), Buffer.from(to, encoding), binary, encoding === "utf16le" ? 2 : 1);
          bytes = result.bytes;
          if (result.replacements > 0) {
            changed = true;
            replacementCount += result.replacements;
          }
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
  const identities = [];
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
    const digest = await packageDigest(source);
    if (digest !== await packageDigest(destination)) throw new Error(`Desktop extension copy failed verification: ${name}`);
    const backend = manifest.main ?? manifest.exports?.["."];
    if (typeof backend === "string" && !await pathExists(join(destination, backend))) {
      throw new Error(`Desktop backend entry is missing: ${name}`);
    }
    identities.push({ name, version: manifest.version, sha256: digest, backend,
      client: manifest.exports?.["./client"], dependencies: manifest.dependencies ?? {}, peers: manifest.peerDependencies ?? {} });
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
  await writeFile(join(harnessDeployment, "desktop-extensions.json"), `${JSON.stringify({ schemaVersion: 1, roots, packages: identities }, null, 2)}\n`);
  return copied;
}

async function packageDigest(root) {
  const hash = createHash("sha256");
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (directory === root && entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else {
        hash.update(relative(root, path).split(sep).join("/"));
        hash.update("\0");
        hash.update(createHash("sha256").update(await readFile(path)).digest());
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
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
    await patchBrowserJsonIntrinsics(destination);
    return restored;
  } finally {
    await writeFile(manifestPath, originalManifest);
    await writeFile(lockPath, originalLock);
  }
}
