import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findInstalledPackages, listInstalledPackages, packageInventory } from "../lib/installed-packages.mjs";

async function createPackage(directory, name, version, license = "MIT") {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version, license })}\n`);
}

test("installed package discovery recursively includes ordinary, scoped, and pnpm nested dependencies", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-installed-packages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modules = join(directory, "node_modules");
  const direct = join(modules, "direct");
  const nested = join(direct, "node_modules", "nested");
  const scoped = join(nested, "node_modules", "@fixture", "scoped");
  const stored = join(modules, ".pnpm", "stored@1.0.0", "node_modules", "stored");
  const storedNested = join(stored, "node_modules", "stored-nested");
  await createPackage(direct, "direct", "1.0.0");
  await createPackage(nested, "nested", "2.0.0", { type: "custom" });
  await createPackage(scoped, "@fixture/scoped", "3.0.0", "ISC");
  await createPackage(stored, "stored", "1.0.0", "Apache-2.0");
  await createPackage(storedNested, "stored-nested", "1.1.0", "BSD-3-Clause");

  const packages = await listInstalledPackages([modules, direct]);
  assert.deepEqual(
    packages.map(item => `${item.manifest.name}@${item.manifest.version}`).sort(),
    ["@fixture/scoped@3.0.0", "direct@1.0.0", "nested@2.0.0", "stored-nested@1.1.0", "stored@1.0.0"]
  );
  assert.deepEqual(await findInstalledPackages([modules], "nested"), [await realpath(nested)]);
  assert.deepEqual(await packageInventory([modules]), [
    { name: "@fixture/scoped", version: "3.0.0", license: "ISC" },
    { name: "direct", version: "1.0.0", license: "MIT" },
    { name: "nested", version: "2.0.0", license: "NOASSERTION" },
    { name: "stored", version: "1.0.0", license: "Apache-2.0" },
    { name: "stored-nested", version: "1.1.0", license: "BSD-3-Clause" }
  ]);
});
