import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";

import { findInstalledPackages, listInstalledPackages } from "../../scripts/lib/installed-packages.mjs";

const runtimeRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(runtimeRoot, "..");
const generatedRoot = join(desktopRoot, "target", "generated");
const preparedRuntime = join(generatedRoot, "runtime", "prepared");
const generatedLock = join(generatedRoot, "runtime-lock.json");
const lock = JSON.parse(await readFile(generatedLock, "utf8"));

function hostTarget() {
  const key = `${process.platform}-${process.arch}`;
  const targets = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc"
  };
  const target = targets[key];
  if (!target) throw new Error(`unsupported runtime host ${key}`);
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

async function pruneNativeArtifacts(nodeModules, target) {
  const profile = lock.nativeAssets[target];
  if (!profile) throw new Error(`native artifact profile is not locked for ${target}`);
  const moduleRoots = [
    nodeModules,
    join(nodeModules, ...lock.runtime.packageName.split("/"), "node_modules")
  ];

  const nodePtyPackages = await findInstalledPackages(moduleRoots, "node-pty");
  if (nodePtyPackages.length === 0) throw new Error("node-pty is absent from the generated Runtime");
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

async function downloadVerified(url, destination, expectedSha256) {
  try {
    if (await hashFile(destination) === expectedSha256) return;
  } catch {}
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await rm(temporary, { force: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`);
  await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
  const actual = await hashFile(temporary);
  if (actual !== expectedSha256) {
    await rm(temporary, { force: true });
    throw new Error(`download checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
}

async function stageOfficialNode(target, sidecar, licenseDestination) {
  const artifact = lock.node.artifacts[target];
  if (!artifact) throw new Error(`Node artifact is not locked for ${target}`);
  const cacheRoot = resolve(desktopRoot, "target/deepseek-desktop-runtime-cache/node", target);
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
  return artifact.sha256;
}

function createSpdx(target, inventory, createdAt) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `DeepSeek-Desktop-Runtime-${target}`,
    documentNamespace: `https://deepseek-desktop.local/${lock.desktopVersion}/sbom/${target}/${lock.runtime.commit}`,
    creationInfo: {
      created: createdAt,
      creators: ["Tool: DeepSeek Desktop runtime staging"]
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
if (!lock.targets.includes(target)) throw new Error(`target ${target} is not present in runtime-lock.json`);
if (target !== hostTarget()) throw new Error(`runtime staging must run on its native target: host=${hostTarget()}, target=${target}`);
if (process.versions.node !== lock.node.version) {
  throw new Error(`Node ${lock.node.version} is required, current runtime is ${process.versions.node}`);
}

const output = join(runtimeRoot, "staging", target);
const stagingRoot = dirname(output);
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await stat(join(preparedRuntime, lock.runtime.entry));
await cp(preparedRuntime, output, { recursive: true, force: true });

// pnpm writes the wall-clock pruning time into this install-only metadata file.
// Node does not consume it at runtime, so omit it from the distributable closure.
await rm(join(output, "node_modules", ".modules.yaml"), { force: true });
await rm(join(output, "node_modules", ...lock.runtime.packageName.split("/"), "node_modules", ".modules.yaml"), { force: true });
await pruneIncompatiblePackages(join(output, "node_modules"), target);
await pruneNativeArtifacts(join(output, "node_modules"), target);

const dshEntry = join(output, lock.runtime.entry);
await stat(dshEntry);

const binarySuffix = process.platform === "win32" ? ".exe" : "";
const sidecar = join(desktopRoot, "src-tauri", "binaries", `node-${target}${binarySuffix}`);
const nodeArchiveSha256 = await stageOfficialNode(target, sidecar, join(output, "licenses", "node-LICENSE.txt"));

const inventory = await packageInventory(join(output, "node_modules"));
inventory.push({ name: "Node.js", version: lock.node.version, license: lock.node.license });
inventory.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
const generatedAt = new Date(lock.sourceDateEpoch * 1_000).toISOString();
await writeFile(join(output, "licenses.json"), `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(join(output, "sbom.spdx.json"), `${JSON.stringify(createSpdx(target, inventory, generatedAt), null, 2)}\n`);
await cp(generatedLock, join(output, "runtime-lock.json"));
await cp(join(runtimeRoot, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md"));

const files = await collectFiles(output);
const manifest = {
  schemaVersion: 1,
  target,
  generatedAt,
  node: {
    version: lock.node.version,
    binary: basename(sidecar),
    sha256: await hashFile(sidecar),
    archiveSha256: nodeArchiveSha256
  },
  runtime: lock.runtime,
  packageCount: inventory.length,
  files
};
await writeFile(join(output, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged ${target}: ${files.length} files, ${inventory.length} packages`);
