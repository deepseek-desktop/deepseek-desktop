import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export async function listInstalledPackages(moduleRoots) {
  const found = new Map();

  async function inspectPackage(directory) {
    try {
      const resolved = await realpath(directory);
      const manifest = JSON.parse(await readFile(join(resolved, "package.json"), "utf8"));
      if (manifest.name) found.set(resolved, { directory: resolved, manifest });
    } catch {}
  }

  async function inspectModules(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === ".bin") continue;
      if (entry.name === ".pnpm" && entry.isDirectory()) {
        for (const storeEntry of await readdir(path, { withFileTypes: true })) {
          if (storeEntry.isDirectory()) await inspectModules(join(path, storeEntry.name, "node_modules"));
        }
      } else if (entry.name.startsWith("@") && entry.isDirectory()) {
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (child.isDirectory() || child.isSymbolicLink()) await inspectPackage(join(path, child.name));
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        await inspectPackage(path);
      }
    }
  }

  for (const root of moduleRoots) {
    await inspectPackage(root);
    await inspectModules(root);
  }
  return [...found.values()].sort((left, right) => left.directory.localeCompare(right.directory));
}

export async function findInstalledPackages(moduleRoots, packageName) {
  return (await listInstalledPackages(moduleRoots))
    .filter(item => item.manifest.name === packageName)
    .map(item => item.directory);
}
