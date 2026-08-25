import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { applyPackagePatch } from "../lib/package-patch.mjs";

const root = resolve(import.meta.dirname, "../..");

test("applies package-relative patches inside a parent Git worktree", async () => {
  const directory = await mkdtemp(join(root, "target", "package-patch-test-"));
  const packageRoot = join(directory, "node_modules", "example-package");
  const sourceFile = join(packageRoot, "lib", "client.js");
  const patchFile = join(directory, "client.patch");
  await mkdir(join(packageRoot, "lib"), { recursive: true });
  await writeFile(sourceFile, 'const message = "before";\n');
  await writeFile(patchFile, [
    "diff --git a/lib/client.js b/lib/client.js",
    "index ea0a2cc..63b9130 100644",
    "--- a/lib/client.js",
    "+++ b/lib/client.js",
    "@@ -1 +1 @@",
    '-const message = "before";',
    '+const message = "after";',
    ""
  ].join("\n"));

  try {
    assert.equal(applyPackagePatch(packageRoot, patchFile), "applied");
    assert.equal(await readFile(sourceFile, "utf8"), 'const message = "after";\n');
    assert.equal(applyPackagePatch(packageRoot, patchFile), "already-applied");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
