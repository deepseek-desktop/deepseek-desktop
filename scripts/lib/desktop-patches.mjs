import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { findInstalledPackages } from "./installed-packages.mjs";
import { applyPackagePatch } from "./package-patch.mjs";

function assertPatchRecord(patch) {
  if (!patch || typeof patch !== "object"
    || typeof patch.packageName !== "string" || patch.packageName.length === 0
    || typeof patch.version !== "string" || patch.version.length === 0
    || typeof patch.id !== "string" || patch.id.length === 0
    || typeof patch.file !== "string" || basename(patch.file) !== patch.file
    || !patch.file.endsWith(".patch")
    || typeof patch.moduleFile !== "string" || patch.moduleFile.length === 0
    || patch.moduleFile.includes("\\")
    || patch.moduleFile.split("/").some(segment => !segment || segment === "." || segment === "..")
    || !Array.isArray(patch.markers) || patch.markers.length === 0
    || patch.markers.some(marker => typeof marker !== "string" || marker.length === 0)
    || typeof patch.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(patch.sha256)) {
    throw new Error("Desktop compatibility patch metadata is invalid");
  }
}

export async function verifyDesktopPatchAsset(patchRoot, patch) {
  assertPatchRecord(patch);
  const patchFile = join(patchRoot, patch.file);
  const bytes = await readFile(patchFile);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== patch.sha256) {
    throw new Error(`Desktop compatibility patch checksum mismatch: ${patch.packageName}:${patch.id}`);
  }
  return patchFile;
}

async function hasAllMarkers(packageRoot, patch) {
  const moduleFile = join(packageRoot, ...patch.moduleFile.split("/"));
  const source = await readFile(moduleFile, "utf8");
  return patch.markers.every(marker => source.includes(marker));
}

/**
 * Bring newly built official Harness packages up to the Desktop compatibility
 * contract. Upstream implementations that already satisfy every marker pass
 * unchanged; otherwise only the exact locked package version may be patched.
 */
export async function applyDesktopCompatibilityPatches(moduleRoots, patches, patchRoot) {
  if (!Array.isArray(moduleRoots) || moduleRoots.length === 0 || !Array.isArray(patches)) {
    throw new Error("Desktop compatibility patch inputs are invalid");
  }
  const applied = [];
  for (const patch of patches) {
    const patchFile = await verifyDesktopPatchAsset(patchRoot, patch);
    const packageRoots = await findInstalledPackages(moduleRoots, patch.packageName);
    if (packageRoots.length === 0) {
      throw new Error(`Desktop compatibility patch target is missing: ${patch.packageName}`);
    }
    for (const packageRoot of packageRoots) {
      if (await hasAllMarkers(packageRoot, patch)) continue;
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      if (manifest.version !== patch.version) {
        throw new Error(
          `Desktop compatibility patch ${patch.packageName}:${patch.id} is absent from ${String(manifest.version)}; expected ${patch.version}`
        );
      }
      applyPackagePatch(packageRoot, patchFile);
      if (!await hasAllMarkers(packageRoot, patch)) {
        throw new Error(`Desktop compatibility patch verification failed: ${patch.packageName}:${patch.id}`);
      }
    }
    applied.push(`${patch.packageName}:${patch.id}:${packageRoots.length}`);
  }
  return applied;
}
