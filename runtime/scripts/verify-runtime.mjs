import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const runtimeRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(runtimeRoot, "..");
const lock = JSON.parse(await readFile(join(runtimeRoot, "runtime-lock.json"), "utf8"));

for (const field of ["sourceDateEpoch", "desktopVersion", "harness", "node", "toolchain", "targets"]) {
  if (lock[field] === undefined) throw new Error(`runtime lock is missing ${field}`);
}
if (lock.harness.commit.length !== 40) throw new Error("Harness commit must be a full SHA");
if (new Set(lock.targets).size !== lock.targets.length) throw new Error("runtime targets contain duplicates");
const pnpmLock = await readFile(join(runtimeRoot, "pnpm-lock.yaml"), "utf8");
if (!pnpmLock.includes(lock.harness.integrity) || !pnpmLock.includes(`@deepseek-ai/dsh@${lock.harness.version}`)) {
  throw new Error("pnpm lock does not match the locked Harness artifact");
}

const requested = process.argv[2];
if (requested) {
  const root = join(runtimeRoot, "staging", requested);
  const manifest = JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8"));
  if (manifest.target !== requested) throw new Error(`manifest target mismatch: ${manifest.target}`);
  if (manifest.generatedAt !== new Date(lock.sourceDateEpoch * 1_000).toISOString()) {
    throw new Error(`manifest timestamp is not reproducible: ${manifest.generatedAt}`);
  }
  if (manifest.node.archiveSha256 !== lock.node.artifacts[requested]?.sha256) {
    throw new Error(`Node source archive mismatch for ${requested}`);
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
  console.log(`runtime manifest verified: ${requested}, ${manifest.files.length} files`);
} else {
  console.log(`runtime lock verified: Harness ${lock.harness.version}, Node ${lock.node.version}`);
}
