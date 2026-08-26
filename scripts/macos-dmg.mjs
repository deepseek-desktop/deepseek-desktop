import { access, mkdir, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const MAX_ATTEMPTS = 3;

export function macDmgFilename(productName, version, architecture) {
  if (!productName?.trim()) throw new Error("productName is required");
  if (!version?.trim()) throw new Error("version is required");
  if (!new Set(["aarch64", "x64"]).has(architecture)) {
    throw new Error(`unsupported macOS DMG architecture ${architecture}`);
  }
  return `${productName}_${version}_${architecture}.dmg`;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function createImage(sourceDirectory, outputPath, volumeName) {
  return spawnSync("hdiutil", [
    "create",
    "-volname",
    volumeName,
    "-srcfolder",
    sourceDirectory,
    "-ov",
    "-format",
    "UDZO",
    outputPath
  ], { stdio: "inherit" });
}

export async function createMacDmg({ bundleRoot, productName, version, architecture }) {
  if (process.platform !== "darwin") throw new Error("macOS DMG packaging requires a macOS host");

  const appDirectory = join(bundleRoot, "macos");
  const appPath = join(appDirectory, `${productName}.app`);
  const applicationsLink = join(appDirectory, "Applications");
  const dmgDirectory = join(bundleRoot, "dmg");
  const outputPath = join(dmgDirectory, macDmgFilename(productName, version, architecture));
  await access(appPath);
  await rm(dmgDirectory, { recursive: true, force: true });
  await mkdir(dmgDirectory, { recursive: true });
  await rm(applicationsLink, { recursive: true, force: true });
  await symlink("/Applications", applicationsLink);

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await rm(outputPath, { force: true });
      console.log(`\n> hdiutil create DMG (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const result = createImage(appDirectory, outputPath, productName);
      if (!result.error && result.status === 0) return outputPath;
      if (attempt === MAX_ATTEMPTS) {
        if (result.error) throw result.error;
        throw new Error(`hdiutil exited with code ${String(result.status)}`);
      }
      sleep(attempt * 3000);
    }
  } finally {
    await rm(applicationsLink, { force: true });
  }

  throw new Error("macOS DMG packaging did not produce an artifact");
}
