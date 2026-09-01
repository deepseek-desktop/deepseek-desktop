import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyPackageTextReplacements } from "../lib/package-text-replacement.mjs";

const root = resolve(import.meta.dirname, "../..");

test("package text replacements are unique, repeatable, and confined to the package", async () => {
  const directory = await mkdtemp(join(root, "target", "package-text-replacement-test-"));
  const packageRoot = join(directory, "package");
  const moduleFile = "lib/client.js";
  const target = join(packageRoot, moduleFile);
  const replacements = [
    { before: ".content{display:flex}", after: ".content{min-height:0;display:flex;overflow:hidden}" },
    { before: ".options{overflow-y:auto}", after: ".options{height:0;overflow-y:auto}" }
  ];

  try {
    await mkdir(join(packageRoot, "lib"), { recursive: true });
    await writeFile(target, "prefix.content{display:flex}.options{overflow-y:auto}suffix");

    assert.equal(applyPackageTextReplacements(packageRoot, moduleFile, replacements), "applied");
    assert.equal(
      await readFile(target, "utf8"),
      "prefix.content{min-height:0;display:flex;overflow:hidden}.options{height:0;overflow-y:auto}suffix"
    );
    assert.equal(applyPackageTextReplacements(packageRoot, moduleFile, replacements), "already-applied");
    assert.throws(
      () => applyPackageTextReplacements(packageRoot, "../outside.js", replacements),
      /escapes package root/u
    );

    await writeFile(target, ".content{display:flex}.content{display:flex}.options{overflow-y:auto}");
    assert.throws(
      () => applyPackageTextReplacements(packageRoot, moduleFile, replacements),
      /before=2, after=0/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package text replacements can target stable CSS module suffixes across generated hashes", async () => {
  const directory = await mkdtemp(join(root, "target", "package-text-replacement-hash-test-"));
  const packageRoot = join(directory, "package");
  const moduleFile = "lib/client.js";
  const target = join(packageRoot, moduleFile);
  const replacements = [
    {
      before: "_content{flex:1;display:flex}",
      after: "_content{flex:1;min-height:0;display:flex;overflow:hidden}"
    }
  ];

  try {
    await mkdir(join(packageRoot, "lib"), { recursive: true });
    await writeFile(target, ".linuxHash_content{flex:1;display:flex}");
    assert.equal(applyPackageTextReplacements(packageRoot, moduleFile, replacements), "applied");
    assert.equal(
      await readFile(target, "utf8"),
      ".linuxHash_content{flex:1;min-height:0;display:flex;overflow:hidden}"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
