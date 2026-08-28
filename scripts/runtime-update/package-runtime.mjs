import { cp, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { artifactName, hostTarget, parseArguments, sha256 } from "./common.mjs";

const root = resolve(import.meta.dirname, "../..");
const args = parseArguments(process.argv.slice(2));
const target = args.get("target") || process.env.TAURI_ENV_TARGET_TRIPLE || hostTarget();
if (target !== hostTarget()) throw new Error(`Runtime update artifacts require a native host: host=${hostTarget()}, target=${target}`);

const app = JSON.parse(await readFile(join(root, "target/generated/app-config.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "target/generated/runtime-lock.json"), "utf8"));
const runtime = join(root, "runtime/staging", target);
const suffix = process.platform === "win32" ? ".exe" : "";
const sidecar = join(root, "src-tauri/binaries", `node-${target}${suffix}`);
await Promise.all([stat(runtime), stat(sidecar), stat(join(runtime, lock.runtime.entry))]);
if (lock.desktopVersion !== app.version) {
  throw new Error(`Runtime lock Desktop version ${String(lock.desktopVersion)} does not match ${app.version}`);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const desktopCommit = git(["rev-parse", "HEAD"]);
const desktopDirty = Boolean(git(["status", "--porcelain", "--untracked-files=all"]));

const output = resolve(args.get("output") || join(root, "release/runtime", lock.runtime.version, target));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "deepseek-runtime-update-"));
try {
  const archiveRoot = join(temporary, "package");
  await mkdir(archiveRoot);
  await cp(runtime, join(archiveRoot, "runtime"), { recursive: true });
  const nodeFile = `node${suffix}`;
  await cp(sidecar, join(archiveRoot, nodeFile));
  if (process.platform !== "win32") await chmod(join(archiveRoot, nodeFile), 0o755);
  const nodeAbiResult = spawnSync(sidecar, ["-p", "process.versions.modules"], { encoding: "utf8" });
  if (nodeAbiResult.error) throw nodeAbiResult.error;
  if (nodeAbiResult.status !== 0) throw new Error(`could not inspect Node module ABI: ${nodeAbiResult.stderr}`);
  const credential = JSON.parse(await readFile(join(runtime, "node_modules/deepseek-desktop-credentials-vault/package.json"), "utf8"));
  const market = JSON.parse(await readFile(join(runtime, "node_modules/dshmarket/package.json"), "utf8"));
  const metadata = {
    schemaVersion: 1,
    target,
    runtimeVersion: lock.runtime.version,
    runtimeCommit: lock.runtime.commit,
    entry: lock.runtime.entry,
    nodeFile,
    nodeVersion: lock.node.version,
    nodeModuleAbi: nodeAbiResult.stdout.trim(),
    runtimeProtocolVersion: app.runtimeUpdate.runtimeProtocolVersion,
    credentialProtocolVersion: app.runtimeUpdate.credentialProtocolVersion,
    credentialProviderVersion: credential.version,
    marketVersion: market.version
  };
  await writeFile(join(archiveRoot, "runtime-package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const filename = artifactName(lock.runtime.version, target);
  const archive = join(output, filename);
  const tar = spawnSync("tar", ["-czf", archive, "runtime-package.json", "runtime", nodeFile], {
    cwd: archiveRoot,
    stdio: "inherit"
  });
  if (tar.error) throw tar.error;
  if (tar.status !== 0) throw new Error(`tar exited with code ${String(tar.status)}`);
  const descriptor = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtimeVersion: metadata.runtimeVersion,
    runtimeCommit: metadata.runtimeCommit,
    runtimeRepository: lock.runtime.sourceUrl,
    runtimeDirty: Boolean(lock.runtime.sourceDirty),
    desktopCommit,
    desktopDirty,
    target,
    runtimeProtocolVersion: metadata.runtimeProtocolVersion,
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
  const descriptorPath = join(output, `runtime-update-descriptor.${target}.json`);
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  console.log(`Runtime update artifact: ${archive}`);
  console.log(`Runtime update descriptor: ${descriptorPath}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
