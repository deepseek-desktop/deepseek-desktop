import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { findInstalledPackages, listInstalledPackages } from "../../scripts/lib/installed-packages.mjs";

const runtimeRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(runtimeRoot, "..");
const generatedRoot = join(desktopRoot, "target", "generated");
const lock = JSON.parse(await readFile(join(generatedRoot, "runtime-lock.json"), "utf8"));
const toolchain = JSON.parse(await readFile(join(runtimeRoot, "toolchain-lock.json"), "utf8"));

function hostTarget() {
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc"
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`unsupported runtime host ${process.platform}-${process.arch}`);
  return target;
}

function packagePath(nodeModules, packageName) {
  return join(nodeModules, ...packageName.split("/"));
}

function targetPlatform(target) {
  return {
    "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
    "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
    "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
    "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64" }
  }[target];
}

function supportsConstraint(constraint, value) {
  if (!Array.isArray(constraint) || constraint.length === 0) return true;
  if (constraint.includes(`!${value}`)) return false;
  const allowed = constraint.filter(item => !item.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

async function hashTree(directory) {
  const hash = createHash("sha256");
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = relative(directory, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) hash.update(`L\0${name}\0${await readlink(path)}\0`);
      else if (info.isDirectory()) {
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

async function verifyPatch(moduleRoots, patch) {
  const lockEntry = `${patch.packageName}:${patch.id}`;
  if (!lock.patches?.some(entry => entry === lockEntry || entry.startsWith(`${lockEntry}:`))) {
    throw new Error(`runtime lock is missing desktop patch ${lockEntry}`);
  }
  if (patch.file) await stat(join(runtimeRoot, "patches", patch.file));
  const packageRoots = await findInstalledPackages(moduleRoots, patch.packageName);
  if (packageRoots.length === 0) throw new Error(`desktop patch target is absent: ${patch.packageName}`);
  for (const packageRoot of packageRoots) {
    const source = await readFile(join(packageRoot, ...patch.moduleFile.split("/")), "utf8");
    for (const marker of patch.markers) {
      if (!source.includes(marker)) {
        throw new Error(`desktop patch ${lockEntry} is absent from ${patch.moduleFile}`);
      }
    }
  }
}

async function verifyPatches(nodeModules) {
  const cliModules = join(packagePath(nodeModules, lock.runtime.packageName), "node_modules");
  for (const patch of toolchain.desktopPatches) await verifyPatch([cliModules, nodeModules], patch);
}

for (const field of ["sourceDateEpoch", "desktopVersion", "runtime", "node", "toolchain", "bundledPackages", "nativeAssets", "targets"]) {
  if (lock[field] === undefined) throw new Error(`runtime lock is missing ${field}`);
}
if (lock.runtime.commit.length !== 40) throw new Error("Runtime commit must be a full SHA");
if (new Set(lock.targets).size !== lock.targets.length) throw new Error("runtime targets contain duplicates");
for (const target of lock.targets) {
  if (!lock.nativeAssets[target]) throw new Error(`runtime lock is missing native assets for ${target}`);
}
const pnpmLock = await readFile(join(runtimeRoot, "pnpm-lock.yaml"), "utf8");
const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
for (const [name, expected] of Object.entries(lock.bundledPackages)) {
  if (runtimePackage.dependencies?.[name] !== expected.version) {
    throw new Error(`runtime package does not lock ${name}@${expected.version}`);
  }
  if (!pnpmLock.includes(`${name}@${expected.version}`) || !pnpmLock.includes(expected.integrity)) {
    throw new Error(`pnpm lock does not match bundled package ${name}@${expected.version}`);
  }
}
const prepared = join(generatedRoot, "runtime", "prepared");
if (await hashTree(prepared) !== lock.runtime.sha256) {
  throw new Error("generated Runtime checksum does not match runtime-lock.json");
}
await verifyPatches(join(prepared, "node_modules"));

const requested = process.argv[2] || hostTarget();
if (requested) {
  const root = join(runtimeRoot, "staging", requested);
  const nativeAssets = lock.nativeAssets[requested];
  const stagedNodeModules = join(root, "node_modules");
  const stagedModuleRoots = [
    stagedNodeModules,
    join(packagePath(stagedNodeModules, lock.runtime.packageName), "node_modules")
  ];
  const platform = targetPlatform(requested);
  if (!platform) throw new Error(`target platform profile is missing for ${requested}`);
  for (const item of await listInstalledPackages(stagedModuleRoots)) {
    if (!supportsConstraint(item.manifest.os, platform.os)
      || !supportsConstraint(item.manifest.cpu, platform.cpu)) {
      throw new Error(`runtime contains incompatible package for ${requested}: ${item.manifest.name}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8"));
  if (manifest.target !== requested) throw new Error(`manifest target mismatch: ${manifest.target}`);
  if (manifest.generatedAt !== new Date(lock.sourceDateEpoch * 1_000).toISOString()) {
    throw new Error(`manifest timestamp is not reproducible: ${manifest.generatedAt}`);
  }
  if (manifest.node.archiveSha256 !== lock.node.artifacts[requested]?.sha256) {
    throw new Error(`Node source archive mismatch for ${requested}`);
  }
  for (const [name, expected] of Object.entries(lock.bundledPackages)) {
    const installed = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
    if (installed.version !== expected.version) {
      throw new Error(`staged Runtime contains ${name}@${installed.version}, expected ${expected.version}`);
    }
  }
  const nodePtyPackages = await findInstalledPackages(stagedModuleRoots, "node-pty");
  if (nodePtyPackages.length === 0) throw new Error("staged Runtime does not contain node-pty");
  for (const packageRoot of nodePtyPackages) {
    const prebuilds = (await readdir(join(packageRoot, "prebuilds"), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    if (prebuilds.length !== 1 || prebuilds[0] !== nativeAssets.nodePtyPrebuild) {
      throw new Error(`node-pty contains non-target prebuilds: ${prebuilds.join(", ")}`);
    }
  }

  const allKoffiPackages = [...new Set(Object.values(lock.nativeAssets).map(item => item.koffiPackage))];
  for (const packageName of allKoffiPackages) {
    const packageRoots = await findInstalledPackages(stagedModuleRoots, `@koromix/${packageName}`);
    if (packageName !== nativeAssets.koffiPackage && packageRoots.length > 0) {
      throw new Error(`runtime contains non-target Koffi package: ${packageName}`);
    }
    if (packageName === nativeAssets.koffiPackage && packageRoots.length === 0) {
      throw new Error(`runtime is missing target Koffi package: ${packageName}`);
    }
    for (const packageRoot of packageRoots) {
      const triplets = (await readdir(packageRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
      if (triplets.length !== 1 || triplets[0] !== nativeAssets.koffiTriplet) {
        throw new Error(`Koffi contains non-target native triplets: ${triplets.join(", ")}`);
      }
      await stat(join(packageRoot, nativeAssets.koffiTriplet, "koffi.node"));
    }
  }
  for (const entry of manifest.files) {
    const filename = join(root, entry.path);
    await stat(filename);
    const actual = createHash("sha256").update(await readFile(filename)).digest("hex");
    if (actual !== entry.sha256) throw new Error(`checksum mismatch: ${entry.path}`);
  }
  const sbom = JSON.parse(await readFile(join(root, "sbom.spdx.json"), "utf8"));
  if (sbom.spdxVersion !== "SPDX-2.3" || sbom.packages.length !== manifest.packageCount) {
    throw new Error("runtime SPDX inventory does not match the manifest");
  }
  const suffix = requested === "x86_64-pc-windows-msvc" ? ".exe" : "";
  const sidecar = join(desktopRoot, "src-tauri", "binaries", `node-${requested}${suffix}`);
  const sidecarSha256 = createHash("sha256").update(await readFile(sidecar)).digest("hex");
  if (sidecarSha256 !== manifest.node.sha256) throw new Error("Node sidecar checksum does not match the runtime manifest");
  await verifyPatches(join(root, "node_modules"));
  console.log(`runtime manifest verified: ${requested}, ${manifest.files.length} files`);
}
