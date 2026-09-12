import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export async function listInstalledPackages(moduleRoots) {
  const found = new Map();
  const inspectedPackages = new Set();
  const inspectedModuleRoots = new Set();

  async function inspectPackage(directory) {
    try {
      const resolved = await realpath(directory);
      if (inspectedPackages.has(resolved)) return;
      inspectedPackages.add(resolved);
      const manifest = JSON.parse(await readFile(join(resolved, "package.json"), "utf8"));
      if (manifest.name) found.set(resolved, { directory: resolved, manifest });
      await inspectModules(join(resolved, "node_modules"));
    } catch {}
  }

  async function inspectModules(directory) {
    let entries;
    try {
      const resolved = await realpath(directory);
      if (inspectedModuleRoots.has(resolved)) return;
      inspectedModuleRoots.add(resolved);
      entries = await readdir(resolved, { withFileTypes: true });
      directory = resolved;
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

export async function packageInventory(moduleRoots) {
  const inventory = new Map();
  for (const item of await listInstalledPackages(moduleRoots)) {
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

export async function findInstalledPackages(moduleRoots, packageName) {
  return (await listInstalledPackages(moduleRoots))
    .filter(item => item.manifest.name === packageName)
    .map(item => item.directory);
}
