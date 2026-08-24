import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";

const runtimeRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(runtimeRoot, "..");
const lock = JSON.parse(await readFile(join(runtimeRoot, "runtime-lock.json"), "utf8"));

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
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}`);
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${String(result.status)}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function runPnpm(args, cwd) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm executable is unavailable; run this script through the package manager");
  run(process.execPath, [pnpmCli, ...args], cwd);
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
  const inventory = [];
  async function inspectModules(modulesDir) {
    let entries;
    try {
      entries = await readdir(modulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".pnpm") continue;
      if (entry.name.startsWith("@")) {
        const scoped = await readdir(join(modulesDir, entry.name), { withFileTypes: true });
        for (const child of scoped) if (child.isDirectory()) await inspectPackage(join(modulesDir, entry.name, child.name));
      } else {
        await inspectPackage(join(modulesDir, entry.name));
      }
    }
  }
  async function inspectPackage(packageDir) {
    try {
      const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
      if (manifest.name && manifest.version && !inventory.some(item => item.name === manifest.name && item.version === manifest.version)) {
        inventory.push({
          name: manifest.name,
          version: manifest.version,
          license: typeof manifest.license === "string" ? manifest.license : "NOASSERTION"
        });
      }
    } catch {
      return;
    }
  }
  await inspectModules(nodeModules);
  return inventory.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
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
  const cacheRoot = resolve(desktopRoot, "../../target/dsh-desktop-runtime-cache/node", target);
  const archive = join(cacheRoot, artifact.archive);
  await downloadVerified(`${lock.node.sourceUrl}${artifact.archive}`, archive, artifact.sha256);
  const extracted = join(cacheRoot, "extracted");
  const marker = join(extracted, ".archive-sha256");
  let prepared = false;
  try { prepared = (await readFile(marker, "utf8")).trim() === artifact.sha256; } catch {}
  if (!prepared) {
    await rm(extracted, { recursive: true, force: true });
    await mkdir(extracted, { recursive: true });
    run("tar", ["-xf", archive, "-C", extracted], cacheRoot);
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
    name: `DSH-Desktop-Runtime-${target}`,
    documentNamespace: `https://springopen.local/dsh-desktop/${lock.desktopVersion}/sbom/${target}/${lock.harness.commit}`,
    creationInfo: {
      created: createdAt,
      creators: ["Tool: DSH Desktop runtime staging"]
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
await rm(output, { recursive: true, force: true });
await mkdir(dirname(output), { recursive: true });
runPnpm(["--filter", "@springopen/dsh-desktop-runtime", "deploy", "--prod", "--legacy", output], runtimeRoot);

// pnpm writes the wall-clock pruning time into this install-only metadata file.
// Node does not consume it at runtime, so omit it from the distributable closure.
await rm(join(output, "node_modules", ".modules.yaml"), { force: true });

const dshEntry = join(output, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
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
await cp(join(runtimeRoot, "runtime-lock.json"), join(output, "runtime-lock.json"));
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
  harness: lock.harness,
  packageCount: inventory.length,
  files
};
await writeFile(join(output, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged ${target}: ${files.length} files, ${inventory.length} packages`);
