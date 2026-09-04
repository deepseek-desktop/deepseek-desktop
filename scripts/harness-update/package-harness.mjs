import { cp, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { artifactName, hostTarget, parseArguments, sha256 } from "./common.mjs";

const root = resolve(import.meta.dirname, "../..");
const args = parseArguments(process.argv.slice(2));
const target = args.get("target") || process.env.TAURI_ENV_TARGET_TRIPLE || hostTarget();
if (target !== hostTarget()) throw new Error(`Harness update artifacts require a native host: host=${hostTarget()}, target=${target}`);

const app = JSON.parse(await readFile(join(root, "target/generated/app-config.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "target/generated/harness-lock.json"), "utf8"));
const harness = join(root, "harness/staging", target);
const suffix = process.platform === "win32" ? ".exe" : "";
const sidecar = join(root, "src-tauri/binaries", `node-${target}${suffix}`);
await Promise.all([stat(harness), stat(sidecar), stat(join(harness, lock.harness.entry))]);
if (lock.desktopVersion !== app.version) {
  throw new Error(`Harness lock Desktop version ${String(lock.desktopVersion)} does not match ${app.version}`);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const desktopCommit = git(["rev-parse", "HEAD"]);
const desktopDirty = Boolean(git(["status", "--porcelain", "--untracked-files=all"]));

const output = resolve(args.get("output") || join(root, "release/harness", lock.harness.version, target));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "deepseek-harness-update-"));
try {
  const archiveRoot = join(temporary, "package");
  await mkdir(archiveRoot);
  await cp(harness, join(archiveRoot, "harness"), { recursive: true });
  const nodeFile = `node${suffix}`;
  await cp(sidecar, join(archiveRoot, nodeFile));
  if (process.platform !== "win32") await chmod(join(archiveRoot, nodeFile), 0o755);
  const nodeAbiResult = spawnSync(sidecar, ["-p", "process.versions.modules"], { encoding: "utf8" });
  if (nodeAbiResult.error) throw nodeAbiResult.error;
  if (nodeAbiResult.status !== 0) throw new Error(`could not inspect Node module ABI: ${nodeAbiResult.stderr}`);
  const credential = JSON.parse(await readFile(join(harness, "node_modules/deepseek-desktop-credentials-vault/package.json"), "utf8"));
  const market = JSON.parse(await readFile(join(harness, "node_modules/dshmarket/package.json"), "utf8"));
  const metadata = {
    schemaVersion: 1,
    target,
    harnessVersion: lock.harness.version,
    harnessCommit: lock.harness.commit,
    entry: lock.harness.entry,
    nodeFile,
    nodeVersion: lock.node.version,
    nodeModuleAbi: nodeAbiResult.stdout.trim(),
    harnessProtocolVersion: app.harnessUpdate.harnessProtocolVersion,
    credentialProtocolVersion: app.harnessUpdate.credentialProtocolVersion,
    credentialProviderVersion: credential.version,
    marketVersion: market.version
  };
  await writeFile(join(archiveRoot, "harness-package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const filename = artifactName(lock.harness.version, target);
  const archive = join(output, filename);
  const tar = spawnSync("tar", ["-czf", archive, "harness-package.json", "harness", nodeFile], {
    cwd: archiveRoot,
    stdio: "inherit"
  });
  if (tar.error) throw tar.error;
  if (tar.status !== 0) throw new Error(`tar exited with code ${String(tar.status)}`);
  const descriptor = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harnessVersion: metadata.harnessVersion,
    harnessCommit: metadata.harnessCommit,
    harnessRepository: lock.harness.sourceUrl,
    harnessDirty: Boolean(lock.harness.sourceDirty),
    desktopCommit,
    desktopDirty,
    target,
    harnessProtocolVersion: metadata.harnessProtocolVersion,
    credentialProtocolVersion: metadata.credentialProtocolVersion,
    credentialProviderVersion: metadata.credentialProviderVersion,
    marketVersion: metadata.marketVersion,
    nodeVersion: metadata.nodeVersion,
    nodeModuleAbi: metadata.nodeModuleAbi,
    artifact: {
      file: basename(archive),
      size: (await stat(archive)).size,
      sha256: await sha256(archive)
    }
  };
  const descriptorPath = join(output, `harness-update-descriptor.${target}.json`);
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  console.log(`Harness update artifact: ${archive}`);
  console.log(`Harness update descriptor: ${descriptorPath}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
