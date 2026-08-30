import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");

const targetContracts = new Map([
  ["aarch64-apple-darwin", [".dmg"]],
  ["x86_64-apple-darwin", [".dmg"]],
  ["x86_64-pc-windows-msvc", [".exe"]],
  ["x86_64-unknown-linux-gnu", [".AppImage", ".deb"]]
]);

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function filesUnder(directory, excluded) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path === excluded || isInside(excluded, path)) continue;
    if (entry.isSymbolicLink()) throw new Error(`release assets cannot contain symbolic links: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await filesUnder(path, excluded));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of text.trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match || checksums.has(match[2])) throw new Error("target SHA256SUMS is invalid");
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

// The Runtime closure digest is host-specific — native prebuilds are compiled by
// the building platform — so the four targets legitimately report different
// `harness.sha256`. Each BUILD-INFO still carries its own digest; it just cannot
// be a cross-platform equality invariant. Everything else that proves "one release
// from one source" is compared exactly.
const IDENTITY_FIELDS = new Map([
  ["application", null],
  ["harness", new Set(["sha256"])],
  ["toolchain", null],
  ["signed", null]
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function releaseIdentityOf(buildInfo) {
  const identity = {};
  for (const [field, hostSpecific] of IDENTITY_FIELDS) {
    const value = buildInfo[field];
    identity[field] = hostSpecific && value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !hostSpecific.has(key)))
      : value;
  }
  return stableValue(identity);
}

// Returns the dotted path of the first field that differs, so a failed aggregation
// is diagnosable from the log instead of by downloading every platform artifact.
function identityMismatch(left, right) {
  for (const field of Object.keys(left)) {
    if (JSON.stringify(left[field]) === JSON.stringify(right[field])) continue;
    const from = left[field];
    const to = right[field];
    if (from && to && typeof from === "object" && typeof to === "object") {
      for (const key of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
        if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) {
          return `${field}.${key} (${JSON.stringify(from[key])} != ${JSON.stringify(to[key])})`;
        }
      }
    }
    return field;
  }
  return null;
}

export async function prepareCiReleaseAssets({ inputRoot, outputRoot, version, commit, toolchainLock }) {
  if (!version || !commit) throw new Error("release version and commit are required");
  const input = resolve(inputRoot);
  const output = resolve(outputRoot);
  if (!isInside(input, output)) throw new Error("release output must be inside the input directory");

  const allFiles = await filesUnder(input, output);
  const buildInfos = allFiles.filter(path => basename(path).startsWith("BUILD-INFO.") && path.endsWith(".json"));
  if (buildInfos.length !== targetContracts.size) throw new Error(`expected ${targetContracts.size} BUILD-INFO files, found ${buildInfos.length}`);

  const seenTargets = new Set();
  const installers = [];
  let releaseIdentity;
  for (const buildInfoPath of buildInfos.sort()) {
    const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
    const extensions = targetContracts.get(buildInfo.target);
    if (!extensions || seenTargets.has(buildInfo.target)) throw new Error(`unexpected or duplicate release target: ${String(buildInfo.target)}`);
    seenTargets.add(buildInfo.target);
    if (buildInfo.application?.version !== version) throw new Error(`release version mismatch for ${buildInfo.target}`);
    if (buildInfo.desktop?.commit !== commit || buildInfo.desktop?.dirty !== false) throw new Error(`release source mismatch for ${buildInfo.target}`);
    if (buildInfo.channel !== "community") throw new Error(`release channel mismatch for ${buildInfo.target}`);
    if (buildInfo.toolchain?.nodeVersion !== toolchainLock.node.version
      || buildInfo.toolchain?.nodeModuleAbi !== toolchainLock.node.moduleAbi
      || buildInfo.toolchain?.rustVersion !== toolchainLock.toolchain.rust
      || buildInfo.toolchain?.pnpmVersion !== toolchainLock.toolchain.pnpm
      || buildInfo.toolchain?.tauriCliVersion !== toolchainLock.toolchain.tauriCli) {
      throw new Error(`release toolchain mismatch for ${buildInfo.target}`);
    }
    if (buildInfo.artifactAudit?.schemaVersion !== 1
      || buildInfo.artifactAudit?.scannerVersion !== 2
      || !Number.isSafeInteger(buildInfo.artifactAudit?.fileCount)
      || buildInfo.artifactAudit.fileCount <= 0
      || !Number.isSafeInteger(buildInfo.artifactAudit?.byteCount)
      || buildInfo.artifactAudit.byteCount <= 0) {
      throw new Error(`release artifact audit is invalid for ${buildInfo.target}`);
    }

    const identity = releaseIdentityOf(buildInfo);
    releaseIdentity ??= identity;
    const mismatch = identityMismatch(releaseIdentity, identity);
    if (mismatch) throw new Error(`release identity mismatch for ${buildInfo.target}: ${mismatch}`);

    const directory = dirname(buildInfoPath);
    const targetFiles = allFiles.filter(path => dirname(path) === directory);
    const targetInstallers = targetFiles.filter(path => extensions.some(extension => path.endsWith(extension)));
    if (targetInstallers.length !== extensions.length
      || extensions.some(extension => targetInstallers.filter(path => path.endsWith(extension)).length !== 1)) {
      throw new Error(`release installer set is invalid for ${buildInfo.target}`);
    }
    const checksumPath = join(directory, "SHA256SUMS");
    const checksums = parseChecksums(await readFile(checksumPath, "utf8"));
    for (const path of [buildInfoPath, ...targetInstallers]) {
      const name = basename(path);
      if (checksums.get(name) !== await sha256(path)) throw new Error(`target checksum mismatch: ${name}`);
    }
    if (checksums.size !== targetInstallers.length + 1) throw new Error(`target SHA256SUMS contains unexpected entries for ${buildInfo.target}`);
    installers.push(...targetInstallers);
  }

  if (seenTargets.size !== targetContracts.size || installers.length !== 5) throw new Error("release target set is incomplete");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const published = [];
  const names = new Set();
  for (const installer of installers.sort()) {
    const name = basename(installer).replaceAll(" ", ".");
    if (names.has(name)) throw new Error(`duplicate public release asset: ${name}`);
    names.add(name);
    const destination = join(output, name);
    await copyFile(installer, destination);
    published.push(destination);
  }
  const checksumLines = [];
  for (const path of published.sort((left, right) => basename(left).localeCompare(basename(right)))) {
    checksumLines.push(`${await sha256(path)}  ${basename(path)}`);
  }
  await writeFile(join(output, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
  return { installers: published, checksums: join(output, "SHA256SUMS") };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const toolchainLock = JSON.parse(await readFile(join(root, "runtime", "toolchain-lock.json"), "utf8"));
  const result = await prepareCiReleaseAssets({
    inputRoot: process.env.CI_RELEASE_ASSETS_INPUT || join(root, "release-assets"),
    outputRoot: process.env.CI_RELEASE_ASSETS_OUTPUT || join(root, "release-assets", "publish"),
    version: process.env.DESKTOP_APP_VERSION,
    commit: process.env.GITHUB_SHA,
    toolchainLock
  });
  console.log(`prepared ${result.installers.length} installers and SHA256SUMS`);
}
