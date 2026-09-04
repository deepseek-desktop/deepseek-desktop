import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";

import { findInstalledPackages, listInstalledPackages } from "../../scripts/lib/installed-packages.mjs";
import { downloadVerified } from "../../scripts/lib/download-verified.mjs";
import { atomicWriteJson } from "../../scripts/release-system/common.mjs";
import {
  contentCacheKey,
  createContentCacheManifest,
  makeContentTreeWritable,
  verifyContentCache
} from "../../scripts/release-system/content-cache.mjs";

const harnessRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(harnessRoot, "..");
const generatedRoot = join(desktopRoot, "target", "generated");
const preparedHarness = join(generatedRoot, "harness", "prepared");
const generatedLock = join(generatedRoot, "harness-lock.json");
const lock = JSON.parse(await readFile(generatedLock, "utf8"));
const harnessCacheRoot = resolve(process.env.DEEPSEEK_DESKTOP_HARNESS_TARGET_CACHE_ROOT?.trim()
  || join(desktopRoot, "target", "local-release", "harness-target-cache"));

function hostTarget() {
  const key = `${process.platform}-${process.arch}`;
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc"
  };
  const target = targets[key];
  if (!target) throw new Error(`unsupported harness host ${key}`);
  return target;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}`);
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function hashFile(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function collectFiles(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, output);
    else if (entry.isFile()) output.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: await hashFile(path) });
  }
  return output;
}

async function packageInventory(nodeModules) {
  const inventory = new Map();
  for (const item of await listInstalledPackages([nodeModules])) {
    const { name, version, license } = item.manifest;
    if (!name || !version) continue;
    inventory.set(`${name}@${version}`, {
      name,
      version,
      license: typeof license === "string" ? license : "NOASSERTION"
    });
  }
  return [...inventory.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

async function retainDirectory(root, expected) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== expected) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

function targetPlatform(target) {
  const profiles = {
    "aarch64-apple-darwin": { os: "darwin", cpu: "arm64" },
    "x86_64-apple-darwin": { os: "darwin", cpu: "x64" },
    "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64" },
    "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64" }
  };
  const profile = profiles[target];
  if (!profile) throw new Error(`target platform profile is missing for ${target}`);
  return profile;
}

function supportsConstraint(constraint, value) {
  if (!Array.isArray(constraint) || constraint.length === 0) return true;
  if (constraint.includes(`!${value}`)) return false;
  const allowed = constraint.filter(item => !item.startsWith("!"));
  return allowed.length === 0 || allowed.includes(value);
}

async function pruneIncompatiblePackages(nodeModules, target) {
  const platform = targetPlatform(target);
  const packages = await listInstalledPackages([nodeModules]);
  for (const item of packages) {
    if (!supportsConstraint(item.manifest.os, platform.os)
      || !supportsConstraint(item.manifest.cpu, platform.cpu)) {
      await rm(item.directory, { recursive: true, force: true });
    }
  }
}

const DEVELOPMENT_DIRECTORIES = new Set(["test", "tests", "__tests__"]);
const DEVELOPMENT_TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;

async function prunePackageDevelopmentFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (DEVELOPMENT_DIRECTORIES.has(entry.name)) {
        await rm(path, { recursive: true, force: true });
      } else {
        await prunePackageDevelopmentFiles(path);
      }
    } else if (entry.isFile() && DEVELOPMENT_TEST_FILE.test(entry.name)) {
      await rm(path, { force: true });
    }
  }
}

async function pruneDevelopmentFiles(nodeModules) {
  for (const item of await listInstalledPackages([nodeModules])) {
    await prunePackageDevelopmentFiles(item.directory);
  }
}

async function pruneNativeArtifacts(nodeModules, target) {
  const profile = lock.nativeAssets[target];
  if (!profile) throw new Error(`native artifact profile is not locked for ${target}`);
  const moduleRoots = [
    nodeModules,
    join(nodeModules, ...lock.harness.packageName.split("/"), "node_modules")
  ];

  const nodePtyPackages = await findInstalledPackages(moduleRoots, "node-pty");
  if (nodePtyPackages.length === 0) throw new Error("node-pty is absent from the generated Harness");
  for (const packageRoot of nodePtyPackages) {
    const prebuilds = join(packageRoot, "prebuilds");
    await retainDirectory(prebuilds, profile.nodePtyPrebuild);
    await stat(join(prebuilds, profile.nodePtyPrebuild));
  }

  const koffiPackages = [...new Set(Object.values(lock.nativeAssets).map(item => item.koffiPackage))];
  for (const packageName of koffiPackages) {
    const directories = await findInstalledPackages(moduleRoots, `@koromix/${packageName}`);
    if (packageName !== profile.koffiPackage) {
      for (const directory of directories) await rm(directory, { recursive: true, force: true });
      continue;
    }
    if (directories.length === 0) throw new Error(`target Koffi package is absent: ${packageName}`);
    for (const directory of directories) {
      await retainDirectory(directory, profile.koffiTriplet);
      await stat(join(directory, profile.koffiTriplet, "koffi.node"));
    }
  }
}

async function stageOfficialNode(target, sidecar, licenseDestination) {
  const artifact = lock.node.artifacts[target];
  if (!artifact) throw new Error(`Node artifact is not locked for ${target}`);
  const cacheRoot = resolve(desktopRoot, "target/deepseek-desktop-harness-cache/node", target);
  const archive = join(cacheRoot, artifact.archive);
  await downloadVerified(`${lock.node.sourceUrl}${artifact.archive}`, archive, artifact.sha256);
  const extracted = join(cacheRoot, "extracted");
  const marker = join(extracted, ".archive-sha256");
  let prepared = false;
  try { prepared = (await readFile(marker, "utf8")).trim() === artifact.sha256; } catch {}
  if (!prepared) {
    await rm(extracted, { recursive: true, force: true });
    await mkdir(extracted, { recursive: true });
    if (process.platform === "win32") {
      const expandArchive = `Expand-Archive -LiteralPath ${powershellLiteral(archive)} -DestinationPath ${powershellLiteral(extracted)} -Force`;
      run("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expandArchive
      ], cacheRoot);
    } else {
      run("tar", ["-xf", archive, "-C", extracted], cacheRoot);
    }
    await writeFile(marker, `${artifact.sha256}\n`);
  }
  const archiveRoot = artifact.archive.replace(/\.tar\.gz$|\.zip$/u, "");
  const binary = process.platform === "win32"
    ? join(extracted, archiveRoot, "node.exe")
    : join(extracted, archiveRoot, "bin", "node");
  const license = join(extracted, archiveRoot, "LICENSE");
  await Promise.all([stat(binary), stat(license)]);
  await mkdir(dirname(sidecar), { recursive: true });
  await cp(binary, sidecar);
  await mkdir(dirname(licenseDestination), { recursive: true });
  await cp(license, licenseDestination);
  const version = runCapture(sidecar, ["--version"], desktopRoot).replace(/^v/u, "");
  if (version !== lock.node.version) throw new Error(`staged Node version mismatch: expected ${lock.node.version}, got ${version}`);
  const moduleAbi = runCapture(sidecar, ["-p", "process.versions.modules"], desktopRoot);
  if (moduleAbi !== lock.node.moduleAbi) throw new Error(`staged Node ABI mismatch: expected ${lock.node.moduleAbi}, got ${moduleAbi}`);
  return artifact.sha256;
}

function createSpdx(target, inventory, createdAt) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `DeepSeek-Desktop-Harness-${target}`,
    documentNamespace: `https://deepseek-desktop.local/${lock.desktopVersion}/sbom/${target}/${lock.harness.commit}`,
    creationInfo: {
      created: createdAt,
      creators: ["Tool: DeepSeek Desktop harness staging"]
    },
    packages: inventory.map((item, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: item.name,
      versionInfo: item.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: item.license,
      licenseDeclared: item.license,
      copyrightText: "NOASSERTION"
    }))
  };
}

const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.argv[2] || hostTarget();
if (!lock.targets.includes(target)) throw new Error(`target ${target} is not present in harness-lock.json`);
if (target !== hostTarget()) throw new Error(`harness staging must run on its native target: host=${hostTarget()}, target=${target}`);
if (process.versions.node !== lock.node.version) {
  throw new Error(`Node ${lock.node.version} is required, current harness is ${process.versions.node}`);
}
if (process.versions.modules !== lock.node.moduleAbi) {
  throw new Error(`Node module ABI ${lock.node.moduleAbi} is required, current ABI is ${process.versions.modules}`);
}

const output = join(harnessRoot, "staging", target);
const stagingRoot = dirname(output);
const binarySuffix = process.platform === "win32" ? ".exe" : "";
const sidecar = join(desktopRoot, "src-tauri", "binaries", `node-${target}${binarySuffix}`);
const cacheIdentity = {
  schemaVersion: 2,
  closurePolicy: "production-without-development-tests-v1",
  target,
  harness: lock.harness,
  patches: lock.patches,
  bundledPackages: lock.bundledPackages,
  node: { version: lock.node.version, moduleAbi: lock.node.moduleAbi, artifact: lock.node.artifacts[target] },
  nativeAssets: lock.nativeAssets[target],
  toolchain: lock.toolchain
};
const cacheKey = contentCacheKey(cacheIdentity);
const cacheDirectory = join(harnessCacheRoot, target, cacheKey);
const cacheStatusPath = join(desktopRoot, "target", "local-release", `harness-cache-${target}.json`);
try {
  await verifyContentCache(cacheDirectory, cacheIdentity);
  await rm(output, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(join(cacheDirectory, "harness"), output, { recursive: true, force: true });
  await makeContentTreeWritable(output);
  await mkdir(dirname(sidecar), { recursive: true });
  await cp(join(cacheDirectory, "sidecar", basename(sidecar)), sidecar, { force: true });
  await atomicWriteJson(cacheStatusPath, { schemaVersion: 1, target, key: cacheKey, hit: true });
  console.log(`staged ${target} from verified Harness cache ${cacheKey.slice(0, 12)}`);
  process.exit(0);
} catch {
  await rm(cacheDirectory, { recursive: true, force: true });
}

await rm(output, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await stat(join(preparedHarness, lock.harness.entry));
await cp(preparedHarness, output, { recursive: true, force: true });
await makeContentTreeWritable(output);

// pnpm writes the wall-clock pruning time into this install-only metadata file.
// Node does not consume it at harness, so omit it from the distributable closure.
await rm(join(output, "node_modules", ".modules.yaml"), { force: true });
await rm(join(output, "node_modules", ...lock.harness.packageName.split("/"), "node_modules", ".modules.yaml"), { force: true });
await pruneIncompatiblePackages(join(output, "node_modules"), target);
await pruneDevelopmentFiles(join(output, "node_modules"));
await pruneNativeArtifacts(join(output, "node_modules"), target);

const dshEntry = join(output, lock.harness.entry);
await stat(dshEntry);

const nodeArchiveSha256 = await stageOfficialNode(target, sidecar, join(output, "licenses", "node-LICENSE.txt"));

const inventory = await packageInventory(join(output, "node_modules"));
inventory.push({ name: "Node.js", version: lock.node.version, license: lock.node.license });
inventory.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const generatedAt = new Date(lock.sourceDateEpoch * 1_000).toISOString();
await writeFile(join(output, "licenses.json"), `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(join(output, "sbom.spdx.json"), `${JSON.stringify(createSpdx(target, inventory, generatedAt), null, 2)}\n`);
await cp(generatedLock, join(output, "harness-lock.json"));
await cp(join(harnessRoot, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md"));

const files = await collectFiles(output);
const manifest = {
  schemaVersion: 1,
  target,
  generatedAt,
  node: {
    version: lock.node.version,
    moduleAbi: lock.node.moduleAbi,
    binary: basename(sidecar),
    sha256: await hashFile(sidecar),
    archiveSha256: nodeArchiveSha256
  },
  harness: lock.harness,
  packageCount: inventory.length,
  files
};
await writeFile(join(output, "harness-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const temporaryCache = join(harnessCacheRoot, target, `.cache-${process.pid}-${Date.now()}`);
await rm(temporaryCache, { recursive: true, force: true });
await mkdir(join(temporaryCache, "harness"), { recursive: true });
await cp(output, join(temporaryCache, "harness"), { recursive: true, force: true });
await mkdir(join(temporaryCache, "sidecar"), { recursive: true });
await cp(sidecar, join(temporaryCache, "sidecar", basename(sidecar)), { force: true });
const cacheManifest = await createContentCacheManifest(temporaryCache, cacheIdentity);
await atomicWriteJson(join(temporaryCache, "cache-manifest.json"), cacheManifest);
await mkdir(dirname(cacheDirectory), { recursive: true });
await rm(cacheDirectory, { recursive: true, force: true });
await rename(temporaryCache, cacheDirectory);
await atomicWriteJson(cacheStatusPath, { schemaVersion: 1, target, key: cacheKey, hit: false });
console.log(`staged ${target}: ${files.length} files, ${inventory.length} packages`);
