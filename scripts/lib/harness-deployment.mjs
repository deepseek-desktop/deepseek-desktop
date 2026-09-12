import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
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
    // Official peer services must come from the candidate Harness. External
    // browser peers such as React come from the audited Desktop dependency set.
    for (const [peer, expected] of Object.entries(manifest.peerDependencies || {})) {
      if (!await pathExists(packagePath(destinationModules, peer)) && !peer.startsWith("@deepseek-ai/")) {
        await visit(peer, !manifest.peerDependenciesMeta?.[peer]?.optional);
      }
      const peerManifest = join(packagePath(destinationModules, peer), "package.json");
      if (!await pathExists(peerManifest) && !manifest.peerDependenciesMeta?.[peer]?.optional) {
        throw new Error(`Candidate Harness peer is missing: ${peer}`);
      }
      if (roots.includes(name) && await pathExists(peerManifest)) {
        const installed = JSON.parse(await readFile(peerManifest, "utf8"));
        assertDesktopPeerVersion(name, peer, expected, installed.version);
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
      for (const dependency of manifest.dsh.client.inject ?? []) {
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

export const DESKTOP_EXTENSION_ROOTS = Object.freeze([
  "deepseek-desktop-bundle", "deepseek-desktop-credentials-vault",
  "@deepseek-ai/dsh-web-search-follow-model", "pnpm"
]);

function assertDesktopPeerVersion(extension, peer, expected, actual) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(expected) || actual !== expected) {
    throw new Error(`Desktop extension ${extension} requires peer ${peer}@${expected}; candidate provides ${actual}`);
  }
}

function supportsTarget(manifest, target) {
  const accepts = (values, value) => !Array.isArray(values)
    || (!values.includes(`!${value}`) && (values.every(item => item.startsWith("!")) || values.includes(value)));
  return accepts(manifest.os, target.platform) && accepts(manifest.cpu, target.arch);
}

function dependencyEdges(manifest) {
  const optional = manifest.optionalDependencies ?? {};
  return [
    ...Object.keys(manifest.dependencies ?? {}).filter(name => !(name in optional)).map(name => [name, true]),
    ...Object.keys(manifest.peerDependencies ?? {}).map(name => [name, !manifest.peerDependenciesMeta?.[name]?.optional]),
    ...Object.keys(optional).map(name => [name, false])
  ];
}

/** Select the same dependency/peer closure as the official npm package-set build. */
export function selectHarnessPackageClosure(workspacePackages, roots, target = process) {
  const selected = new Map();
  const excluded = {};
  function visit(name, required = true, parent) {
    if (selected.has(name)) return;
    const item = workspacePackages.get(name);
    if (!item) {
      if (required) throw new Error(`Harness source package is missing: ${name}`);
      return;
    }
    if (!supportsTarget(item.manifest, target)) {
      if (required) throw new Error(`Harness package does not support ${target.platform}/${target.arch}: ${name}`);
      excluded[`${parent}>${name}`] = "-";
      return;
    }
    if (item.manifest.private) throw new Error(`Harness runtime requires an unpublished package: ${name}`);
    selected.set(name, item);
    for (const [dependency, requiredDependency] of dependencyEdges(item.manifest)) {
      if (workspacePackages.has(dependency)) visit(dependency, requiredDependency, name);
      else if (requiredDependency && dependency.startsWith("@deepseek-ai/")) {
        throw new Error(`Harness source package ${name} requires an unpacked internal package: ${dependency}`);
      }
    }
  }
  for (const root of roots) visit(root);
  return { packages: [...selected.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)), excluded };
}

async function desktopHarnessPeers(desktopDeployment, roots, workspacePackages) {
  if (!desktopDeployment) return [];
  const peers = new Set();
  const visited = new Set();
  async function visit(name, required = true) {
    if (visited.has(name)) return;
    if (workspacePackages.has(name)) { peers.add(name); return; }
    const path = join(packagePath(join(desktopDeployment, "node_modules"), name), "package.json");
    if (!await pathExists(path)) {
      if (required) throw new Error(`Desktop dependency is missing: ${name}`);
      return;
    }
    visited.add(name);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    for (const [peer, expected] of Object.entries(manifest.peerDependencies ?? {})) {
      if (workspacePackages.has(peer)) {
        if (roots.includes(name)) assertDesktopPeerVersion(name, peer, expected, workspacePackages.get(peer).manifest.version);
        peers.add(peer);
      }
      else if (peer.startsWith("@deepseek-ai/") && !manifest.peerDependenciesMeta?.[peer]?.optional) {
        throw new Error(`Desktop extension requires a missing Harness source package: ${peer}`);
      }
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await visit(dependency);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) await visit(dependency, false);
  }
  for (const root of roots) await visit(root);
  return [...peers].sort();
}

async function installedDependency(directory, name) {
  for (let current = await realpath(directory); ; current = dirname(current)) {
    const candidate = packagePath(join(current, "node_modules"), name);
    if (await pathExists(join(candidate, "package.json"))) return realpath(candidate);
    if (dirname(current) === current) return null;
  }
}

/** Only carry upstream patches whose exact targets occur in the selected production graph. */
async function selectRuntimePatches(sourceRoot, packages, workspacePackages, workspace, staging) {
  const visited = new Set();
  const identities = new Set();
  async function visit(item) {
    const directory = await realpath(item.directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    identities.add(`${item.manifest.name}@${item.manifest.version}`);
    for (const [name, required] of dependencyEdges(item.manifest)) {
      if (workspacePackages.has(name)) continue;
      const dependency = await installedDependency(directory, name);
      if (!dependency) {
        if (required) throw new Error(`Built Harness dependency is missing: ${item.manifest.name} -> ${name}`);
        continue;
      }
      const manifest = JSON.parse(await readFile(join(dependency, "package.json"), "utf8"));
      if (!supportsTarget(manifest, process) && !required) continue;
      await visit({ directory: dependency, manifest });
    }
  }
  for (const item of packages) await visit(item);
  const patches = {};
  const records = [];
  for (const [identity, file] of Object.entries(workspace.patchedDependencies ?? {})) {
    if (!identities.has(identity)) continue;
    const source = resolve(sourceRoot, file);
    const relation = relative(sourceRoot, source);
    if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
      throw new Error(`Harness patch escapes its source: ${identity}`);
    }
    const bytes = await readFile(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const patch = `patches/${sha256}.patch`;
    await mkdir(join(staging, "patches"), { recursive: true });
    await writeFile(join(staging, patch), bytes);
    patches[identity] = patch;
    records.push({ package: identity, sha256 });
  }
  return { patches, records };
}

function packedManifest(tarball) {
  const result = spawnSync("tar", ["-xOzf", tarball, "package/package.json"], {
    encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) throw new Error(`Harness package manifest cannot be read: ${basename(tarball)}`);
  return JSON.parse(result.stdout);
}

export function verifyHarnessPackageLock(lock, packages) {
  const importer = lock.importers?.["."];
  if (!importer) throw new Error("Harness runtime lock has no root importer");
  for (const record of packages) {
    const spec = `file:packages/${record.file}`;
    const resolved = importer.dependencies?.[record.name];
    const specifier = resolved?.specifier?.replace(/^file:\.\//u, "file:");
    if (specifier !== spec || !(resolved?.version === spec || resolved?.version?.startsWith(`${spec}(`))) {
      throw new Error(`Harness runtime lock resolved ${record.name} outside its local package set`);
    }
    for (const key of Object.keys(lock.packages ?? {})) {
      if (key.startsWith(`${record.name}@`) && !key.startsWith(`${record.name}@file:packages/${record.file}`)) {
        throw new Error(`Harness runtime lock contains an external core package: ${key}`);
      }
    }
  }
}

/** Package the official CLI closure, then install only immutable local core tarballs. */
export async function deployHarnessClosure(sourceRoot, workspacePackages, cli, destination, runHarnessPnpm, options = {}) {
  const desktopRoots = options.desktopRoots ?? DESKTOP_EXTENSION_ROOTS;
  const peers = await desktopHarnessPeers(options.desktopDeployment, desktopRoots, workspacePackages);
  const roots = [cli.manifest.name, ...peers];
  const { packages, excluded } = selectHarnessPackageClosure(workspacePackages, roots);
  // js-yaml is a declared dependency of the official CLI, already installed by build:official.
  const yaml = createRequire(join(cli.directory, "package.json"))("js-yaml");
  const upstreamWorkspace = yaml.load(await readFile(join(sourceRoot, "pnpm-workspace.yaml"), "utf8"));
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), "harness-package-set-"));
  try {
    const tarballs = join(staging, "packages");
    await mkdir(tarballs);
    await runHarnessPnpm([
      ...packages.flatMap(item => ["--filter", item.manifest.name]),
      "--recursive", "pack", "--workspace-concurrency=4", "--pack-destination", tarballs
    ], sourceRoot);
    const records = [];
    const names = new Set(packages.map(item => item.manifest.name));
    for (const file of (await readdir(tarballs)).sort()) {
      if (!file.endsWith(".tgz")) throw new Error(`Unexpected Harness package-set file: ${file}`);
      const manifest = packedManifest(join(tarballs, file));
      const expected = workspacePackages.get(manifest.name);
      if (!names.delete(manifest.name) || manifest.version !== expected?.manifest.version) {
        throw new Error(`Harness packed identity differs from selected source: ${file}`);
      }
      for (const [dependency, required] of dependencyEdges(manifest)) {
        if (required && dependency.startsWith("@deepseek-ai/") && !packages.some(item => item.manifest.name === dependency)) {
          throw new Error(`Harness packed package requires an unpacked internal package: ${dependency}`);
        }
      }
      const bytes = await readFile(join(tarballs, file));
      records.push({ name: manifest.name, version: manifest.version, file, bytes: bytes.length,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
    }
    if (names.size) throw new Error(`Harness pack omitted source packages: ${[...names].join(", ")}`);
    records.sort((a, b) => a.name.localeCompare(b.name));
    const overrides = Object.fromEntries(records.map(record => [record.name, `file:./packages/${record.file}`]));
    const { patches, records: patchRecords } = await selectRuntimePatches(sourceRoot, packages, workspacePackages, upstreamWorkspace, staging);
    const allowBuilds = { ...(upstreamWorkspace.allowBuilds ?? {}) };
    for (const record of records) {
      const scripts = workspacePackages.get(record.name).manifest.scripts ?? {};
      if (!scripts.install && !scripts.postinstall && !scripts.preinstall) continue;
      const approved = Object.entries(allowBuilds).some(([name, allowed]) => allowed
        && (name === record.name || name.startsWith(`${record.name}@`)));
      if (!approved) throw new Error(`Harness runtime install script is not approved upstream: ${record.name}`);
      allowBuilds[`${record.name}@${overrides[record.name].replace("file:./", "file:")}`] = true;
    }
    await writeFile(join(staging, "package.json"), `${JSON.stringify({
      name: "deepseek-desktop-harness-runtime", private: true, version: cli.manifest.version,
      type: "module", dependencies: overrides
    }, null, 2)}\n`);
    await writeFile(join(staging, "pnpm-workspace.yaml"), yaml.dump({
      packages: ["."], nodeLinker: "hoisted", autoInstallPeers: false, strictDepBuilds: true,
      overrides: { ...overrides, ...excluded }, allowBuilds,
      minimumReleaseAgeExclude: upstreamWorkspace.minimumReleaseAgeExclude ?? [],
      ...(Object.keys(patches).length ? { patchedDependencies: patches } : {})
    }));
    await runHarnessPnpm(["install", "--lockfile-only"], staging);
    const lock = yaml.load(await readFile(join(staging, "pnpm-lock.yaml"), "utf8"));
    verifyHarnessPackageLock(lock, records);
    await runHarnessPnpm(["install", "--prod", "--frozen-lockfile", "--trust-lockfile"], staging);
    await materializePackageLinks(join(staging, "node_modules"));
    for (const record of records) {
      const installed = JSON.parse(await readFile(join(packagePath(join(staging, "node_modules"), record.name), "package.json"), "utf8"));
      if (installed.name !== record.name || installed.version !== record.version) {
        throw new Error(`Installed Harness package differs from local package set: ${record.name}`);
      }
    }
    await stat(join(packagePath(join(staging, "node_modules"), cli.manifest.name), cli.entry));
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await cp(join(staging, "node_modules"), join(destination, "node_modules"), { recursive: true });
    await writeFile(join(destination, "package.json"), `${JSON.stringify({
      name: "deepseek-desktop-harness-runtime", private: true, version: cli.manifest.version,
      type: "module", dependencies: Object.fromEntries(records.map(record => [record.name, record.version]))
    }, null, 2)}\n`);
    const packageSet = { schemaVersion: 1, roots, packages: records, upstreamPatches: patchRecords };
    await writeFile(join(destination, "harness-packages.json"), `${JSON.stringify(packageSet, null, 2)}\n`);
    await patchBrowserJsonIntrinsics(destination);
    return packageSet;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
